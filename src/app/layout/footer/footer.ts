import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-footer',
  templateUrl: './footer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Footer {
  protected readonly year = new Date().getFullYear();

  protected readonly columns = [
    {
      title: 'Tienda',
      links: ['Verduras y raíces', 'Frutas frescas', 'Listos para comer', 'Canastas semanales'],
    },
    {
      title: 'La cooperativa',
      links: ['Nuestras 38 fincas', 'Cómo fijamos los precios', 'Certificación orgánica', 'Trabaja con nosotros'],
    },
    {
      title: 'Ayuda',
      links: ['Zonas de entrega', 'Preguntas frecuentes', 'Devoluciones', 'Contacto'],
    },
  ];
}
