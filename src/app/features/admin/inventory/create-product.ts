import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody } from '../../../core/api/api-client';
import {
  MAX_FILE_BYTES,
  PRODUCT_PRESET,
  formatBytes,
  processImage,
  validateFile,
} from '../../../shared/utils/image-file';

@Component({
  selector: 'app-create-product',
  imports: [ReactiveFormsModule, RouterLink],
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
    unidad: ['', Validators.required],
    origen: ['', Validators.required],
    imagenAlt: ['', Validators.required],
    imagen: ['', Validators.required],
    imagenHover: [''],
  });

  protected creatingProduct = false;
  protected createError: string | null = null;

  /**
   * La foto se redimensiona y recomprime antes de guardarla.
   *
   * Sin este paso iba tal cual del móvil a la base: una foto de 4 MB se
   * convierte en ~5,3 MB de base64, por encima del límite de 2 MB por fila de
   * D1, y la creación fallaba con un error del servidor sin explicación.
   */
  protected async handleImageUpload(event: Event, fieldName: 'imagen' | 'imagenHover'): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const invalid = validateFile(file);
    if (invalid) {
      this.createError =
        invalid === 'tipo'
          ? 'Ese formato no sirve. Usa JPG, PNG o WEBP.'
          : `La imagen supera los ${formatBytes(MAX_FILE_BYTES)}.`;
      input.value = '';
      return;
    }

    try {
      const { dataUrl } = await processImage(file, PRODUCT_PRESET);
      this.form.patchValue({ [fieldName]: dataUrl });
      this.createError = null;
    } catch {
      this.createError = 'No se pudo leer esa imagen. Prueba con otra.';
      input.value = '';
    }
  }

  protected createProduct(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.createError = null;
    this.creatingProduct = true;

    const { nombre, slug, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, origen, imagen, imagenHover, imagenAlt } = this.form.getRawValue();

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

  protected showError(field: 'nombre' | 'categoriaId' | 'grupoAdmin' | 'precio' | 'precioCosto' | 'unidad' | 'origen' | 'imagenAlt' | 'imagen' | 'imagenHover'): boolean {
    const control = this.form.get(field);
    return control ? control.invalid && (control.touched || control.dirty) : false;
  }
}
