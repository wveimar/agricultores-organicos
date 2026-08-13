import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody, ApiProduct } from '../../../core/api/api-client';
import { ImageField } from './image-field/image-field';
import {
  ALL_UNITS,
  ProductUnit,
  UNIT_LABELS,
  unitPresentation,
} from '../../../core/models/product.model';

@Component({
  selector: 'app-edit-product',
  imports: [ReactiveFormsModule, RouterLink, ImageField],
  templateUrl: './edit-product.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditProduct {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly adminApi = inject(AdminApiService);

  protected readonly productId = this.route.snapshot.paramMap.get('id') || '';
  protected readonly product = signal<ApiProduct | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.minLength(2)]],
    slug: [''],
    tagline: [''],
    categoriaId: ['', Validators.required],
    grupoAdmin: ['frutas' as const, Validators.required],
    precio: [0, [Validators.required, Validators.min(1)]],
    precioCosto: [0, [Validators.required, Validators.min(1)]],
    unidad: ['unidad', Validators.required],
    cantidadUnidad: [1, [Validators.required, Validators.min(1)]],
    origen: ['', Validators.required],
    imagenAlt: ['', Validators.required],
    imagen: ['', Validators.required],
    imagenHover: [''],
  });

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
          grupoAdmin: prod.grupoAdmin as any,
          precio: prod.precio,
          precioCosto: prod.precioCosto ?? 0,
          unidad: prod.unidad,
          cantidadUnidad: prod.cantidadUnidad ?? 1,
          origen: prod.origen,
          imagen: prod.imagen,
          imagenHover: prod.imagenHover ?? '',
          imagenAlt: prod.imagenAlt,
        });
      }
    });
    this.loadProduct();
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

    const { nombre, slug, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, cantidadUnidad, origen, imagen, imagenHover, imagenAlt } = this.form.getRawValue();

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
