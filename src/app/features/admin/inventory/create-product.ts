import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody } from '../../../core/api/api-client';
import { ImageField } from './image-field/image-field';
import {
  ALL_UNITS,
  ProductUnit,
  UNIT_LABELS,
  unitPresentation,
} from '../../../core/models/product.model';

@Component({
  selector: 'app-create-product',
  imports: [ReactiveFormsModule, RouterLink, ImageField],
  templateUrl: './create-product.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateProduct {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly adminApi = inject(AdminApiService);

  protected readonly form = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.minLength(2)]],
    slug: [''],
    tagline: [''],
    categoriaId: ['', Validators.required],
    grupoAdmin: ['frutas' as const, Validators.required],
    precio: [0, [Validators.required, Validators.min(1)]],
    precioCosto: [0, [Validators.required, Validators.min(0)]],
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

  protected creatingProduct = false;
  protected createError: string | null = null;

  protected createProduct(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.createError = null;
    this.creatingProduct = true;

    const { nombre, slug, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, cantidadUnidad, origen, imagen, imagenHover, imagenAlt } = this.form.getRawValue();

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
