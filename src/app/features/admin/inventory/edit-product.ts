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
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import {
  ADMIN_GROUP_OF,
  ALL_UNITS,
  CategoryId,
  ProductUnit,
  UNIT_LABELS,
  unitPresentation,
} from '../../../core/models/product.model';
import { CATEGORIES } from '../../../core/data/mock-catalog';

@Component({
  selector: 'app-edit-product',
  imports: [ReactiveFormsModule, RouterLink, ImageField, CopPipe],
  templateUrl: './edit-product.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditProduct {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly adminApi = inject(AdminApiService);

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
    // Se anota la unión completa y no `as const`: el valor inicial es 'frutas',
    // pero al cargar una ficha puede llegar cualquiera de los tres.
    grupoAdmin: ['frutas' as 'frutas' | 'verduras' | 'agroindustriales', Validators.required],
    precio: [0, [Validators.required, Validators.min(1)]],
    precioCosto: [0, [Validators.required, Validators.min(1)]],
    unidad: ['unidad', Validators.required],
    cantidadUnidad: [1, [Validators.required, Validators.min(1)]],
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
   * Categorías elegibles: las de la vitrina menos «Todo el huerto», que es un
   * filtro y no un sitio donde archivar nada.
   *
   * Antes esto era un campo de texto libre con el ejemplo «hortalizas», que no
   * es ninguna de ellas. Un producto guardado con una categoría inventada solo
   * sale bajo «Todo el huerto» y desaparece de todos los chips — el fallo que
   * tuvo que reparar la migración `0010_normalizar_categorias`.
   */
  protected readonly categorias = CATEGORIES.filter((c) => c.id !== 'todos');

  /**
   * La categoría de esta ficha, si no está en el catálogo actual.
   *
   * Al pasar de texto libre a desplegable quedan fichas con valores que ya no
   * existen. Sin una opción que las represente, el `<select>` no casaría con
   * ninguna y guardar sin tocar el campo reescribiría la categoría en silencio.
   */
  protected readonly categoriaFueraDeLista = computed(() => {
    const actual = this.product()?.categoriaId;
    if (!actual || this.categorias.some((c) => c.id === actual)) {
      return null;
    }
    return actual;
  });

  /**
   * El grupo del panel se deduce de la categoría: `ADMIN_GROUP_OF` es una
   * función total sobre `CategoryId`, así que no hay pareja válida que elegir
   * a mano. Se sincroniza en vez de bloquearse para no romper las fichas
   * antiguas que ya traigan otra combinación.
   */
  protected onCategoriaChange(event: Event): void {
    const id = (event.target as HTMLSelectElement).value as CategoryId;
    const grupo = ADMIN_GROUP_OF[id];
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
          grupoAdmin: prod.grupoAdmin as 'frutas' | 'verduras' | 'agroindustriales',
          precio: prod.precio,
          precioCosto: prod.precioCosto ?? 0,
          unidad: prod.unidad,
          cantidadUnidad: prod.cantidadUnidad ?? 1,
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

    const { nombre, slug, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, cantidadUnidad, origen, imagen, imagenHover, imagenAlt, parentId, varianteEtiqueta } = this.form.getRawValue();

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

  protected showError(field: 'nombre' | 'categoriaId' | 'grupoAdmin' | 'precio' | 'precioCosto' | 'unidad' | 'cantidadUnidad' | 'origen' | 'imagenAlt' | 'imagen' | 'imagenHover'): boolean {
    const control = this.form.get(field);
    return control ? control.invalid && (control.touched || control.dirty) : false;
  }
}
