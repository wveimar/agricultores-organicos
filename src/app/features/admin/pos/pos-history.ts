import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { TokenStore } from '../../../core/api/token-store';
import {
  ApiCashConsolidado,
  ApiCashSummary,
  ApiErrorBody,
  ApiPosVenta,
  ApiPosVentaResumen,
} from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { PosReceipt } from './pos-receipt';

/**
 * Historial de la caja: lo vendido en el mostrador, su cierre y sus devoluciones.
 *
 * Tres cosas que conviene entender de esta pantalla:
 *
 * · **El cierre de aquí es solo el del mostrador.** La tienda web tiene el
 *   suyo, en Reportes. Se cierran por separado porque son dos cajones
 *   distintos, y el consolidado de abajo los suma para ver el día completo.
 *
 * · **Reimprimir no necesita nada especial.** Una venta guardada ya trae todo
 *   lo que lleva el recibo, así que volver a imprimirlo es volver a pintarlo.
 *
 * · **Devolver lo autoriza un SUPER_ADMIN.** El Worker lo exige igual; aquí
 *   solo se esconde el botón para no ofrecer algo que va a dar 403.
 */
@Component({
  selector: 'app-pos-history',
  standalone: true,
  imports: [RouterLink, CopPipe, PosReceipt],
  templateUrl: './pos-history.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PosHistory {
  private readonly admin = inject(AdminApiService);
  private readonly session = inject(TokenStore);

  protected readonly ventas = this.admin.posVentas;
  protected readonly resumen = this.admin.posResumen;
  protected readonly cargando = this.admin.posLoading;
  protected readonly errorLista = this.admin.posError;

  protected readonly soloHoy = signal(true);

  protected readonly caja = signal<ApiCashSummary | null>(null);
  protected readonly consolidado = signal<ApiCashConsolidado | null>(null);

  protected readonly cerrando = signal(false);
  protected readonly mensaje = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  /** La venta cuyo recibo se está reimprimiendo, si hay alguna. */
  protected readonly reimprimiendo = signal<ApiPosVenta | null>(null);

  /** La venta que se está devolviendo, con las cantidades marcadas. */
  protected readonly devolviendo = signal<ApiPosVentaResumen | null>(null);
  protected readonly cantidadesDevueltas = signal<Record<string, number>>({});
  protected readonly motivoDevolucion = signal('');
  protected readonly devolviendoEnCurso = signal(false);

  protected readonly puedeDevolver = computed(() => this.session.roles().includes('SUPER_ADMIN'));

  constructor() {
    this.recargar();
  }

  protected recargar(): void {
    this.admin.loadPosVentas({ hoy: this.soloHoy() });
    this.admin.posCashSummary('pos').subscribe({
      next: (resumen) => this.caja.set(resumen),
      error: () => this.caja.set(null),
    });
    this.admin.cashConsolidado().subscribe({
      next: (datos) => this.consolidado.set(datos),
      error: () => this.consolidado.set(null),
    });
  }

  protected alternarPeriodo(): void {
    this.soloHoy.set(!this.soloHoy());
    this.admin.loadPosVentas({ hoy: this.soloHoy() });
  }

  protected cerrarCaja(): void {
    this.cerrando.set(true);
    this.mensaje.set(null);
    this.error.set(null);

    this.admin.closePosCash('pos').subscribe({
      next: (res) => {
        this.mensaje.set(
          `Caja del mostrador cerrada (${res.closing.referencia}): ${res.pedidosArchivados} venta(s) archivadas.`,
        );
        this.cerrando.set(false);
        this.recargar();
      },
      error: (err: ApiErrorBody) => {
        this.error.set(err.message);
        this.cerrando.set(false);
      },
    });
  }

  // ── Reimpresión ────────────────────────────────────────────────────────

  /**
   * El historial ya trae las líneas de cada venta, así que el recibo se arma
   * sin pedir nada más: reimprimir no cuesta una petición.
   */
  protected reimprimir(venta: ApiPosVentaResumen): void {
    this.reimprimiendo.set({
      id: venta.id,
      referencia: venta.referencia,
      contactId: venta.contactId,
      clienteNombre: venta.clienteNombre,
      clienteTelefono: '',
      estado: venta.estado,
      subtotal: venta.subtotal,
      envio: 0,
      total: venta.total,
      metodoPago: venta.metodoPago,
      canal: 'pos',
      reciboSolicitado: venta.reciboSolicitado,
      venceEn: null,
      creadoEn: venta.creadoEn,
      items: venta.items,
      factura: venta.invoiceId
        ? {
            id: venta.invoiceId,
            numero: venta.invoiceNumero ?? '',
            total: venta.total,
            saldo: 0,
            estado: venta.estado,
            emitidaEn: venta.creadoEn,
          }
        : null,
    });
  }

  protected cerrarReimpresion(): void {
    this.reimprimiendo.set(null);
  }

  protected imprimir(): void {
    window.print();
  }

  // ── Devoluciones ───────────────────────────────────────────────────────

  protected abrirDevolucion(venta: ApiPosVentaResumen): void {
    this.devolviendo.set(venta);
    this.cantidadesDevueltas.set({});
    this.motivoDevolucion.set('');
    this.error.set(null);
  }

  protected cerrarDevolucion(): void {
    this.devolviendo.set(null);
  }

  protected setCantidadDevuelta(productId: string, valor: string): void {
    const cantidad = Math.max(0, Number(valor) || 0);
    this.cantidadesDevueltas.set({ ...this.cantidadesDevueltas(), [productId]: cantidad });
  }

  protected readonly lineasADevolver = computed(() =>
    Object.entries(this.cantidadesDevueltas())
      .filter(([, cantidad]) => cantidad > 0)
      .map(([productId, cantidad]) => ({ productId, cantidad })),
  );

  protected readonly puedeConfirmarDevolucion = computed(
    () =>
      this.lineasADevolver().length > 0 &&
      this.motivoDevolucion().trim().length > 0 &&
      !this.devolviendoEnCurso(),
  );

  protected confirmarDevolucion(): void {
    const venta = this.devolviendo();
    if (!venta || !this.puedeConfirmarDevolucion()) {
      return;
    }

    this.devolviendoEnCurso.set(true);
    this.error.set(null);

    this.admin
      .posDevolucion(venta.id, {
        items: this.lineasADevolver(),
        motivo: this.motivoDevolucion().trim(),
      })
      .subscribe({
        next: (res) => {
          this.mensaje.set(
            `Devolución registrada: nota ${res.nota.numero} por ${res.unidadesDevueltas} unidad(es). El stock ya volvió al inventario.`,
          );
          this.devolviendoEnCurso.set(false);
          this.devolviendo.set(null);
          this.recargar();
        },
        error: (err: ApiErrorBody) => {
          this.error.set(err.message);
          this.devolviendoEnCurso.set(false);
        },
      });
  }
}
