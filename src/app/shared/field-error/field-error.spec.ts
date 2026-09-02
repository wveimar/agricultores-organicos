import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { FieldError, FieldErrorState } from './field-error';

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, FieldErrorState, FieldError],
  template: `
    <input
      #err="fieldError"
      [formControl]="control"
      [appFieldError]="control"
      [forzado]="forzado()"
    />
    <app-field-error [for]="err" message="Escribe algo." />
  `,
})
class HostStub {
  readonly control = new FormControl('', Validators.required);
  /**
   * Una señal, no un campo suelto: es como se enlaza de verdad en la app —
   * cada formulario guarda su estado en señales. Un binding contra un campo
   * plano mutado a mano por fuera de Angular nunca dispararía una nueva
   * comprobación en esta app zoneless: sin un escritor de señal (o un evento
   * del propio control) de por medio, nada le avisa al planificador que hay
   * algo que volver a mirar.
   */
  readonly forzado = signal(false);
}

describe('FieldError / FieldErrorState', () => {
  let fixture: ComponentFixture<HostStub>;
  let host: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostStub] });
    fixture = TestBed.createComponent(HostStub);
    host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  const input = () => host.querySelector('input')!;
  const mensaje = () => host.querySelector('p');

  it('no se muestra en un control inválido recién creado (pristine, sin tocar)', () => {
    expect(mensaje()).toBeNull();
  });

  it('no marca aria-invalid mientras no se ha mostrado ningún error', () => {
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(input().getAttribute('aria-describedby')).toBeNull();
  });

  it('aparece al marcar el control como touched, y marca aria-invalid', () => {
    fixture.componentInstance.control.markAsTouched();
    fixture.detectChanges();

    expect(mensaje()).not.toBeNull();
    expect(mensaje()!.textContent).toContain('Escribe algo.');
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('enlaza el input con su mensaje por aria-describedby', () => {
    fixture.componentInstance.control.markAsTouched();
    fixture.detectChanges();

    const describedBy = input().getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(mensaje()!.id).toBe(describedBy);
  });

  it('aparece al hacerse dirty, sin necesidad de touched', () => {
    fixture.componentInstance.control.markAsDirty();
    fixture.detectChanges();

    expect(mensaje()).not.toBeNull();
  });

  it('desaparece en cuanto el control pasa a ser válido', () => {
    fixture.componentInstance.control.markAsTouched();
    fixture.detectChanges();
    expect(mensaje()).not.toBeNull();

    fixture.componentInstance.control.setValue('algo');
    fixture.detectChanges();

    expect(mensaje()).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBe('false');
  });

  /**
   * El caso `payments-manager`: un control que el código llenó por otra vía
   * (el botón "Cobrar" desde la lista de deudores) nace pristine y sin tocar,
   * así que ni `touched` ni `dirty` lo delatarían solos.
   */
  it('con forzado=true se muestra aunque el control esté pristine', () => {
    fixture.componentInstance.forzado.set(true);
    fixture.detectChanges();

    expect(mensaje()).not.toBeNull();
  });

  it('no se muestra si un control forzado además es válido', () => {
    fixture.componentInstance.control.setValue('algo');
    fixture.componentInstance.forzado.set(true);
    fixture.detectChanges();

    expect(mensaje()).toBeNull();
  });

  it('genera un id estable, distinto entre instancias', () => {
    fixture.componentInstance.control.markAsTouched();
    fixture.detectChanges();
    const id = mensaje()!.id;
    expect(id).toMatch(/^field-error-\d+$/);

    // Una segunda instancia no puede compartir id: es lo que hace seguro el
    // emparejamiento con `aria-describedby` cuando hay varios campos en la
    // misma pantalla.
    const segunda = TestBed.createComponent(HostStub);
    segunda.componentInstance.control.markAsTouched();
    segunda.detectChanges();
    const segundoId = (segunda.nativeElement as HTMLElement).querySelector('p')!.id;
    expect(segundoId).not.toBe(id);
  });
});
