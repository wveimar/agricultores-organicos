import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiCarteraRow, ApiErrorBody } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Los cuatro tramos, en el orden en que preocupan. */
const TRAMOS = [
  { value: '90', label: 'Más de 60 días' },
  { value: '60', label: '31 a 60 días' },
  { value: '30', label: 'Hasta 30 días' },
  { value: 'corriente', label: 'Aún no vence' },
] as const;

type Tramo = (typeof TRAMOS)[number]['value'];

/**
 * Cartera: lo que los mayoristas se llevaron fiado y todavía no han pagado.
 *
 * La antigüedad —cuántos días lleva vencida cada factura y en qué tramo cae—
 * la calcula el Worker contra el reloj de la base de datos, no este
 * componente. Si la calculara el navegador, dos personas en husos distintos
 * verían vencida la misma factura en días distintos, y la que decide si se
 * despacha o no un pedido nuevo es esa cifra.
 *
 * Cobrar una deuda no la borra: cambia el pedido a 'pago', que es lo que lo
 * vuelve elegible para el siguiente cierre de caja. El dinero entra a la
 * jornada en que de verdad se recibió (ver la migración 0017).
 */
@Component({
  selector: 'app-portfolio',
  imports: [CopPipe],
  templateUrl: './portfolio.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Portfolio {
  protected readonly adminApi = inject(AdminApiService);

  protected readonly tramos = TRAMOS;

  protected readonly busqueda = signal('');
  protected readonly tramoActivo = signal<Tramo | 'todos'>('todos');

  /** Fila que está cobrándose ahora mismo, para bloquear solo su botón. */
  protected readonly cobrandoId = signal<string | null>(null);
  /** Fila cuya confirmación está abierta: registrar un pago no se deshace. */
  protected readonly confirmandoId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.adminApi.loadCartera();
  }

  protected readonly visible = computed<readonly ApiCarteraRow[]>(() => {
    const termino = this.busqueda().trim().toLowerCase();
    const tramo = this.tramoActivo();

    return this.adminApi.cartera().filter((deuda) => {
      if (tramo !== 'todos' && deuda.tramo !== tramo) {
        return false;
      }
      if (!termino) {
        return true;
      }
      // También por referencia: quien llama por teléfono suele citar el número
      // del pedido antes que su propio nombre.
      return (
        deuda.clienteNombre.toLowerCase().includes(termino) ||
        deuda.referencia.toLowerCase().includes(termino) ||
        deuda.clienteTelefono.includes(termino)
      );
    });
  });

  /** Suma de lo que se está viendo, que con un filtro puesto no es el total. */
  /** Con domicilio: es lo que hay que cobrar de las facturas a la vista. */
  protected readonly totalVisible = computed(() =>
    this.visible().reduce((suma, deuda) => suma + deuda.total + deuda.envio, 0),
  );

  /** Cuánto hay en cada tramo, para las pestañas. */
  protected readonly porTramo = computed<Record<string, number>>(() => {
    const totales: Record<string, number> = {};
    for (const deuda of this.adminApi.cartera()) {
      // Con domicilio, igual que `totalVisible`: las pestañas y el pie de la
      // lista tienen que sumar lo mismo o parece que una de las dos falla.
      totales[deuda.tramo] = (totales[deuda.tramo] ?? 0) + deuda.total + deuda.envio;
    }
    return totales;
  });

  protected readonly cuantosEnTramo = computed<Record<string, number>>(() => {
    const cuenta: Record<string, number> = {};
    for (const deuda of this.adminApi.cartera()) {
      cuenta[deuda.tramo] = (cuenta[deuda.tramo] ?? 0) + 1;
    }
    return cuenta;
  });

  /**
   * «Vence en 12 días», «Vencida hace 3 días», «Vence hoy».
   *
   * El signo viene del servidor: negativo es que falta. Se traduce aquí porque
   * un número suelto con signo no se lee de un vistazo, y esta pantalla se
   * mira para decidir a quién llamar hoy.
   */
  protected plazo(deuda: ApiCarteraRow): string {
    const dias = deuda.diasVencido;
    if (dias === null) {
      return 'Sin fecha de vencimiento';
    }
    if (dias > 0) {
      return `Vencida hace ${dias} ${dias === 1 ? 'día' : 'días'}`;
    }
    if (dias === 0) {
      return 'Vence hoy';
    }
    const faltan = -dias;
    return `Vence en ${faltan} ${faltan === 1 ? 'día' : 'días'}`;
  }

  protected seleccionarTramo(tramo: Tramo | 'todos'): void {
    this.tramoActivo.set(this.tramoActivo() === tramo ? 'todos' : tramo);
  }

  protected onBuscar(event: Event): void {
    this.busqueda.set((event.target as HTMLInputElement).value);
  }

  protected preguntar(id: string): void {
    this.error.set(null);
    this.confirmandoId.set(id);
  }

  protected cancelar(): void {
    this.confirmandoId.set(null);
  }

  protected cobrar(id: string): void {
    this.error.set(null);
    this.cobrandoId.set(id);

    this.adminApi.collectCredit(id).subscribe({
      next: () => {
        this.cobrandoId.set(null);
        this.confirmandoId.set(null);
      },
      error: (error: ApiErrorBody) => {
        this.cobrandoId.set(null);
        this.confirmandoId.set(null);
        this.error.set(error.message);
      },
    });
  }
}
