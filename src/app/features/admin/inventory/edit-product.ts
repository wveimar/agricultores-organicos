import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody, ApiProduct } from '../../../core/api/api-client';
import { ImageField } from './image-field/image-field';
import { RecipeEditor } from './recipe-editor/recipe-editor';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { FieldError, FieldErrorState } from '../../../shared/field-error/field-error';
import {
  ALL_UNITS,
  ProductUnit,
  UNIT_LABELS,
  unitPresentation,
} from '../../../core/models/product.model';

@Component({
  selector: 'app-edit-product',
  imports: [ReactiveFormsModule, RouterLink, ImageField, CopPipe, RecipeEditor, FieldErrorState, FieldError],
  templateUrl: './edit-product.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditProduct {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly adminApi = inject(AdminApiService);

  protected readonly productId = this.route.snapshot.paramMap.get('id') || '';

  /**
   * Se llega aquí recién duplicado. El aviso vive en esta pantalla y no en el
   * inventario porque la navegación es inmediata: un mensaje allí se vería
   * medio segundo y nadie llegaría a leerlo.
   */
  protected readonly esCopia = this.route.snapshot.queryParamMap.get('copia') === '1';
  protected readonly product = signal<ApiProduct | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.minLength(2)]],
    slug: [''],
    tagline: [''],
    categoriaId: ['', Validators.required],
    // 'frutas' es solo el valor inicial; el desplegable sale de
    // `adminApi.groupOptions()`, no de una lista fija (migración 0025).
    grupoAdmin: ['frutas', Validators.required],
    precio: [0, [Validators.required, Validators.min(1)]],
    precioCosto: [0, [Validators.required, Validators.min(1)]],
    unidad: ['unidad', Validators.required],
    cantidadUnidad: [1, [Validators.required, Validators.min(1)]],
    /** 1 = se vende a granel: la caja pide un peso decimal, no un conteo. */
    vendidoPorPeso: [false],
    origen: ['', Validators.required],
    imagenAlt: ['', Validators.required],
    imagen: ['', Validators.required],
    imagenHover: [''],
    /** '' = se vende solo. Con un id, es variante de ese producto. */
    parentId: [''],
    /** Qué distingue a sus variantes. Solo se usa si este producto es madre. */
    varianteEtiqueta: [''],
  });

  // ─────────────────────────────── Variantes ───────────────────────────────

  /** Las variantes que ya cuelgan de este producto, si es madre. */
  protected readonly variantes = computed(() => this.adminApi.variantsOf(this.productId));

  /**
   * Madres posibles. Sale vacío si este producto ya agrupa variantes: colgarlo
   * de otro convertiría a sus hijas en nietas, y el catálogo solo pinta un
   * nivel. El desplegable se sustituye entonces por una explicación.
   */
  protected readonly madresPosibles = computed(() =>
    this.adminApi.possibleParents(this.productId),
  );

  protected readonly esMadre = computed(() => this.variantes().length > 0);

  /** Lo que hay escrito ahora mismo en el selector, para decidir qué mostrar. */
  protected readonly parentSeleccionado = signal('');

  protected readonly madreActual = computed(() => {
    const id = this.parentSeleccionado();
    return id ? this.adminApi.productById(id) : undefined;
  });

  /** Suma del inventario de las hijas: lo que de verdad hay de esta ficha. */
  protected readonly stockDeVariantes = computed(() =>
    this.variantes().reduce((total, variante) => total + variante.stock, 0),
  );

  /**
   * Categorías elegibles, leídas de la tabla `categories`.
   *
   * Antes esto era un campo de texto libre con el ejemplo «hortalizas», que no
   * era ninguna categoría real. Un producto guardado con una inventada solo
   * sale bajo «Todo el huerto» y desaparece de todos los chips — el fallo que
   * tuvo que reparar la migración `0010`, y que volvió a pasar con 'fermentos'.
   */
  protected readonly categorias = this.adminApi.selectableCategories;

  /**
   * La categoría de esta ficha, si no está en el catálogo actual.
   *
   * Al pasar de texto libre a desplegable quedan fichas con valores que ya no
   * existen. Sin una opción que las represente, el `<select>` no casaría con
   * ninguna y guardar sin tocar el campo reescribiría la categoría en silencio.
   */
  protected readonly categoriaFueraDeLista = computed(() => {
    const actual = this.product()?.categoriaId;
    if (!actual || this.categorias().some((c) => c.id === actual)) {
      return null;
    }
    return actual;
  });

  /**
   * El grupo del panel se deduce de la categoría: cada fila trae el suyo, así
   * que no hay pareja que elegir a mano. Se sincroniza en vez de bloquearse
   * para no romper las fichas antiguas que ya traigan otra combinación.
   */
  protected onCategoriaChange(event: Event): void {
    const grupo = this.adminApi.categoryById((event.target as HTMLSelectElement).value)?.grupoAdmin;
    if (grupo) {
      this.form.controls.grupoAdmin.setValue(grupo);
    }
  }

  /** Unidades ofrecidas en el selector, con su etiqueta legible. */
  protected readonly unidades = ALL_UNITS.map((value) => ({
    value,
    label: UNIT_LABELS[value].singular,
  }));

  /**
   * Cómo se verá la presentación en la tienda, en vivo mientras se escribe.
   *
   * Evita el error más fácil de cometer aquí: poner 500 con la unidad en 'kg'
   * y publicar «500 kg de tomate» sin que nadie lo note hasta que lo lea un
   * cliente. Es un método y no un `computed`: el valor ya vive en el formulario
   * reactivo, y duplicarlo en una señal serían dos fuentes que se desincronizan.
   */
  protected vistaPrevia(): string {
    const { cantidadUnidad, unidad } = this.form.getRawValue();
    return unitPresentation(Number(cantidadUnidad) || 1, unidad as ProductUnit);
  }

  protected updatingProduct = false;
  protected updateError: string | null = null;

  constructor() {
    effect(() => {
      const prod = this.product();
      if (prod) {
        this.form.setValue({
          nombre: prod.nombre,
          slug: prod.slug,
          tagline: prod.tagline,
          categoriaId: prod.categoriaId,
          grupoAdmin: prod.grupoAdmin,
          precio: prod.precio,
          precioCosto: prod.precioCosto ?? 0,
          unidad: prod.unidad,
          cantidadUnidad: prod.cantidadUnidad ?? 1,
          vendidoPorPeso: prod.vendidoPorPeso === 1,
          origen: prod.origen,
          imagen: prod.imagen,
          imagenHover: prod.imagenHover ?? '',
          imagenAlt: prod.imagenAlt,
          parentId: prod.parentId ?? '',
          varianteEtiqueta: prod.varianteEtiqueta ?? '',
        });
        this.parentSeleccionado.set(prod.parentId ?? '');
      }
    });

    // El desplegable de categoría sale de la tabla: sin esto quedaría vacío al
    // entrar directo por URL, y la ficha parecería no tener categoría.
    if (this.adminApi.categories().length === 0) {
      this.adminApi.loadCategories();
    }
    if (this.adminApi.adminGroups().length === 0) {
      this.adminApi.loadAdminGroups();
    }

    this.loadProduct();
  }

  protected onParentChange(event: Event): void {
    this.parentSeleccionado.set((event.target as HTMLSelectElement).value);
  }

  private loadProduct(): void {
    const products = this.adminApi.products();
    const prod = products.find(p => p.id === this.productId);

    if (prod) {
      this.product.set(prod);
      this.loading.set(false);
    } else {
      this.loadError.set('Producto no encontrado');
      this.loading.set(false);
    }
  }

  protected updateProduct(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.updateError = null;
    this.updatingProduct = true;

    const { nombre, slug, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, cantidadUnidad, vendidoPorPeso, origen, imagen, imagenHover, imagenAlt, parentId, varianteEtiqueta } = this.form.getRawValue();

    this.adminApi
      .updateProductFull(this.productId, {
        nombre,
        slug: slug || undefined,
        tagline,
        categoriaId,
        grupoAdmin,
        precio,
        precioCosto,
        unidad,
        cantidadUnidad,
        vendidoPorPeso: vendidoPorPeso ? 1 : 0,
        origen,
        imagen,
        imagenHover: imagenHover || undefined,
        imagenAlt,
        // Se manda siempre —incluido `null`— porque este formulario **sí**
        // muestra el campo: dejarlo vacío aquí es una decisión de quien edita,
        // no un descuido de una pantalla que no lo conoce.
        parentId: parentId || null,
        // La etiqueta solo significa algo en una madre. Al colgar el producto
        // de otra ficha se limpia, para que no quede un «presentación»
        // huérfano que reaparecería si algún día se vuelve a soltar.
        varianteEtiqueta: parentId ? null : varianteEtiqueta.trim() || null,
      })
      .subscribe({
        next: () => {
          this.updatingProduct = false;
          void this.router.navigate(['/admin/inventario']);
        },
        error: (error: ApiErrorBody) => {
          this.updatingProduct = false;
          this.updateError = error.message;
        },
      });
  }

}
