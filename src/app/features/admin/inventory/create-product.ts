import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody } from '../../../core/api/api-client';

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

  protected async handleImageUpload(event: Event, fieldName: 'imagen' | 'imagenHover'): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      this.form.patchValue({ [fieldName]: dataUrl });
    };
    reader.readAsDataURL(file);
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
