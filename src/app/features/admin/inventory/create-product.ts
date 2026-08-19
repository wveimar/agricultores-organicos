import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
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
  selector: 'app-create-product',
  imports: [ReactiveFormsModule, RouterLink, ImageField, CopPipe],
  templateUrl: './create-product.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateProduct {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly adminApi = inject(AdminApiService);

  protected readonly form = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.minLength(2)]],
    slug: [''],
    tagline: [''],
    categoriaId: ['', Validators.required],
    // Se anota la unión completa y no `as const`: el valor inicial es 'frutas',
    // pero al precargar desde una ficha madre puede llegar cualquiera de los
    // tres, y con el tipo estrecho eso no compila.
    grupoAdmin: ['frutas' as 'frutas' | 'verduras' | 'agroindustriales', Validators.required],
    precio: [0, [Validators.required, Validators.min(1)]],
    precioCosto: [0, [Validators.required, Validators.min(0)]],
    unidad: ['unidad', Validators.required],
    cantidadUnidad: [1, [Validators.required, Validators.min(1)]],
    origen: ['', Validators.required],
    imagenAlt: ['', Validators.required],
    imagen: ['', Validators.required],
    imagenHover: [''],
    /** '' = se vende solo. Con un id, nace como variante de ese producto. */
    parentId: [''],
    /** Qué distinguirá a sus variantes, si esta ficha va a agrupar alguna. */
    varianteEtiqueta: [''],
  });

  // ─────────────────────────────── Variantes ───────────────────────────────

  /**
   * Id que llega en `?parent=`, al pulsar «Añadir variante» en el inventario.
   *
   * Es la vía normal de crear una: se entra ya sabiendo de qué ficha cuelga, y
   * el formulario se rellena con lo que la variante comparte con su madre
   * —categoría, grupo, origen, foto— para que solo quede escribir lo que de
   * verdad cambia: el nombre, el precio y el tamaño.
   */
  private readonly parentParam = this.route.snapshot.queryParamMap.get('parent') ?? '';

  protected readonly parentSeleccionado = signal(this.parentParam);

  protected readonly madresPosibles = computed(() => this.adminApi.possibleParents(null));

  protected readonly madreActual = computed(() => {
    const id = this.parentSeleccionado();
    return id ? this.adminApi.productById(id) : undefined;
  });

  /** Las que ya cuelgan de la madre elegida: se enseñan para no repetir una. */
  protected readonly hermanas = computed(() => {
    const id = this.parentSeleccionado();
    return id ? this.adminApi.variantsOf(id) : [];
  });

  constructor() {
    // Se puede aterrizar aquí directamente, con la lista de productos todavía
    // vacía: sin esto el desplegable de madres saldría sin opciones.
    if (this.adminApi.products().length === 0) {
      this.adminApi.loadProducts();
    }

    this.form.controls.parentId.setValue(this.parentParam);

    // La precarga espera a que llegue el inventario, y se hace una sola vez:
    // a partir de ahí manda lo que escriba quien está creando el producto.
    let precargado = false;
    effect(() => {
      const madre = this.adminApi.productById(this.parentParam);
      if (!this.parentParam || precargado || !madre) {
        return;
      }
      precargado = true;
      untracked(() => this.copiarDeLaMadre(madre));
    });
  }

  /**
   * Rellena lo que una variante comparte con su ficha madre.
   *
   * Lo que **no** se copia y por qué: el nombre lleva encima lo que distingue a
   * esta variante («· 500 gr»), el precio es justo lo que cambia entre
   * presentaciones, y la cantidad es el dato que hace falta pensar. Copiarlos
   * invitaría a guardar tres variantes idénticas por descuido.
   */
  private copiarDeLaMadre(madre: ApiProduct): void {
    this.form.patchValue({
      nombre: `${madre.nombre} · `,
      tagline: madre.tagline,
      categoriaId: madre.categoriaId,
      grupoAdmin: madre.grupoAdmin as 'frutas' | 'verduras' | 'agroindustriales',
      unidad: madre.unidad,
      origen: madre.origen,
      imagen: madre.imagen,
      imagenHover: madre.imagenHover ?? '',
      imagenAlt: madre.imagenAlt,
    });
  }

  protected onParentChange(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    this.parentSeleccionado.set(id);

    // Elegir madre a mano en un formulario vacío también precarga: es el mismo
    // trabajo, y dejarlo sin hacer solo porque no se entró por el atajo sería
    // una diferencia que nadie sabría explicar.
    const madre = id ? this.adminApi.productById(id) : undefined;
    if (madre && !this.form.controls.nombre.value.trim()) {
      this.copiarDeLaMadre(madre);
    }
  }

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

  protected creatingProduct = false;
  protected createError: string | null = null;

  protected createProduct(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.createError = null;
    this.creatingProduct = true;

    const { nombre, slug, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, cantidadUnidad, origen, imagen, imagenHover, imagenAlt, parentId, varianteEtiqueta } = this.form.getRawValue();

    this.adminApi
      .createProduct({
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
        parentId: parentId || null,
        // Solo significa algo en una madre: una variante que la llevara dejaría
        // un dato muerto que reaparecería si algún día se suelta de su ficha.
        varianteEtiqueta: parentId ? null : varianteEtiqueta.trim() || null,
      })
      .subscribe({
        next: () => {
          this.creatingProduct = false;
          void this.router.navigate(['/admin/inventario']);
        },
        error: (error: ApiErrorBody) => {
          this.creatingProduct = false;
          this.createError = error.message;
        },
      });
  }

  protected showError(field: 'nombre' | 'categoriaId' | 'grupoAdmin' | 'precio' | 'precioCosto' | 'unidad' | 'cantidadUnidad' | 'origen' | 'imagenAlt' | 'imagen' | 'imagenHover'): boolean {
    const control = this.form.get(field);
    return control ? control.invalid && (control.touched || control.dirty) : false;
  }
}
