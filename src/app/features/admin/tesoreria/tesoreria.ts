import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiCuentaTesoreria, ApiErrorBody } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { TesoreriaResumen } from './tabs/tesoreria-resumen';
import { TesoreriaMovimientos } from './tabs/tesoreria-movimientos';
import { TesoreriaPorCobrar } from './tabs/tesoreria-por-cobrar';
import { TesoreriaPorPagar } from './tabs/tesoreria-por-pagar';
import { TesoreriaDevoluciones } from './tabs/tesoreria-devoluciones';
import { TesoreriaGastos } from './tabs/tesoreria-gastos';
import { TesoreriaCierre } from './tabs/tesoreria-cierre';

/**
 * Tesorería — dónde está la plata y a dónde se va.
 *
 * Junta en una sola pantalla lo que antes estaba repartido entre «Cartera»,
 * «Gastos» y el cierre que vivía dentro de Reportes. La razón no es de orden:
 * es que las tres responden a la misma pregunta desde ángulos distintos, y
 * tenerlas en menús separados obligaba a ir y volver para cuadrar un día.
 *
 * ── Por qué las pestañas viven aquí y no en el enrutador ──
 *
 * Podrían ser rutas hijas. Se resolvió con una señal porque la cabecera —los
 * saldos de las cuentas— es la misma en todas y tiene que quedarse quieta al
 * cambiar de pestaña: con rutas hijas, cada navegación volvería a montarla y
 * los saldos parpadearían. Además el resumen se pide UNA vez y lo comparten
 * todas.
 */
export type PestanaTesoreria =
  | 'resumen'
  | 'movimientos'
  | 'por-cobrar'
  | 'devoluciones'
  | 'por-pagar'
  | 'gastos'
  | 'cierre';

@Component({
  selector: 'app-tesoreria',
  standalone: true,
  imports: [
    CopPipe,
    TesoreriaResumen,
    TesoreriaMovimientos,
    TesoreriaPorCobrar,
    TesoreriaDevoluciones,
    TesoreriaPorPagar,
    TesoreriaGastos,
    TesoreriaCierre,
  ],
  templateUrl: './tesoreria.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Tesoreria {
  protected readonly admin = inject(AdminApiService);

  protected readonly pestana = signal<PestanaTesoreria>('resumen');

  /**
   * Las pestañas, en el orden en que se usan durante el día: primero se mira
   * cómo va la cosa, después se busca un movimiento, luego se cobra, se
   * devuelve lo que se cobró de más y se paga, y al final se cuadra.
   *
   * «Devoluciones» va justo después de «Por cobrar»: es la misma cartera de
   * clientes vista al revés —plata que YO le debo a él, no que él me debe a
   * mí— y por eso convive cerca, aunque el dinero corra en sentido contrario.
   */
  protected readonly pestanas: readonly {
    id: PestanaTesoreria;
    etiqueta: string;
    contador?: () => number;
  }[] = [
    { id: 'resumen', etiqueta: 'Resumen' },
    { id: 'movimientos', etiqueta: 'Movimientos' },
    {
      id: 'por-cobrar',
      etiqueta: 'Por cobrar',
      contador: () => this.admin.tesoreria()?.porCobrar.clientes ?? 0,
    },
    {
      id: 'devoluciones',
      etiqueta: 'Devoluciones',
      contador: () => this.admin.tesoreria()?.porDevolver.notas ?? 0,
    },
    {
      id: 'por-pagar',
      etiqueta: 'Por pagar',
      contador: () => this.admin.tesoreria()?.porPagar.cuentas ?? 0,
    },
    { id: 'gastos', etiqueta: 'Gastos' },
    { id: 'cierre', etiqueta: 'Cierre de caja' },
  ];

  constructor() {
    this.admin.loadTesoreria();
  }

  protected irA(pestana: PestanaTesoreria): void {
    this.pestana.set(pestana);
  }

  // ── La cabecera de saldos, común a las seis pestañas ──────────────────

  protected readonly resumen = this.admin.tesoreria;
  protected readonly cuentas = this.admin.cuentasTesoreria;

  protected readonly disponible = computed(() => this.resumen()?.disponible ?? 0);

  /**
   * Un saldo en rojo NO es un error de la pantalla: el Worker deja registrar
   * un gasto aunque deje la cuenta en negativo, porque es el registro de algo
   * que ya pasó. El rojo es la alarma de que falta anotar de dónde entró
   * plata, así que se pinta, no se esconde.
   */
  protected enRojo(cuenta: ApiCuentaTesoreria): boolean {
    return cuenta.saldo < 0;
  }

  protected readonly hayAlgoEnRojo = computed(() => this.cuentas().some((c) => c.saldo < 0));

  // ── Mover plata: ingreso, egreso y traslado ───────────────────────────
  //
  // Los tres son el MISMO formulario. Un ingreso y un egreso solo se
  // diferencian en el signo, y un traslado es un egreso que además dice a
  // dónde llegó. Hacer tres modales separados sería copiar el mismo campo de
  // monto tres veces y tener que arreglar tres validaciones cada vez.

  protected readonly formulario = signal<TipoDeMovimiento | null>(null);
  protected readonly cuentaOrigen = signal('caja-efectivo');
  protected readonly cuentaDestino = signal('cuenta-bancaria');
  protected readonly monto = signal(0);
  protected readonly concepto = signal('');
  protected readonly tercero = signal('');
  protected readonly referencia = signal('');
  protected readonly guardando = signal(false);
  protected readonly errorForm = signal<string | null>(null);

  protected readonly TITULOS: Readonly<Record<TipoDeMovimiento, string>> = {
    ingreso: 'Registrar ingreso',
    egreso: 'Registrar egreso',
    traslado: 'Trasladar entre cuentas',
  };

  protected abrirFormulario(tipo: TipoDeMovimiento): void {
    this.formulario.set(tipo);
    this.errorForm.set(null);
    this.monto.set(0);
    this.concepto.set('');
    this.tercero.set('');
    this.referencia.set('');
  }

  protected cerrarFormulario(): void {
    this.formulario.set(null);
  }

  protected readonly puedeGuardar = computed(
    () =>
      this.monto() > 0 &&
      this.concepto().trim() !== '' &&
      !this.guardando() &&
      // Trasladar de una cuenta a ella misma no mueve nada; el Worker lo
      // rechaza, pero es mejor que el botón no deje ni intentarlo.
      (this.formulario() !== 'traslado' || this.cuentaDestino() !== this.cuentaOrigen()),
  );

  protected guardarMovimiento(): void {
    const tipo = this.formulario();
    if (!tipo || !this.puedeGuardar()) return;

    this.guardando.set(true);
    this.errorForm.set(null);

    this.admin
      .crearMovimientoTesoreria({
        tipo,
        cuentaId: this.cuentaOrigen(),
        cuentaDestinoId: tipo === 'traslado' ? this.cuentaDestino() : undefined,
        monto: this.monto(),
        concepto: this.concepto().trim(),
        tercero: this.tercero().trim() || undefined,
        referencia: this.referencia().trim() || undefined,
      })
      .subscribe({
        next: () => {
          this.guardando.set(false);
          this.cerrarFormulario();
        },
        error: (err: ApiErrorBody) => {
          this.guardando.set(false);
          this.errorForm.set(err.message);
        },
      });
  }

  // ── Exportar el libro ─────────────────────────────────────────────────

  protected readonly exportando = signal(false);

  /**
   * Se pide el libro al Worker en vez de exportar lo que hay en pantalla.
   *
   * Lo que se ve puede estar filtrado o recortado a 300 filas; un CSV que
   * dice «movimientos» y trae un subconjunto silencioso es peor que no tener
   * el botón, porque quien lo abre en Excel cree que ahí está todo.
   */
  protected exportarCsv(): void {
    this.exportando.set(true);

    this.admin.tesoreriaMovimientos({}).subscribe({
      next: ({ movimientos }) => {
        this.exportando.set(false);
        descargarCsv(
          `tesoreria-${new Date().toISOString().slice(0, 10)}.csv`,
          ['Fecha', 'Cuenta', 'Tipo', 'Concepto', 'Tercero', 'Referencia', 'Entra', 'Sale'],
          movimientos.map((m) => [
            m.fecha,
            m.cuentaNombre ?? '',
            m.tipo,
            m.concepto,
            m.tercero ?? '',
            m.referencia ?? '',
            String(m.entra),
            String(m.sale),
          ]),
        );
      },
      error: (err: ApiErrorBody) => {
        this.exportando.set(false);
        this.errorForm.set(err.message);
      },
    });
  }
}

export type TipoDeMovimiento = 'ingreso' | 'egreso' | 'traslado';

/**
 * Arma el CSV y lo baja.
 *
 * Separador `;` y BOM al principio: Excel en español abre con `,` como
 * separador decimal, así que un CSV con comas le parte «10,5» en dos
 * columnas. El BOM es lo que le dice que el archivo viene en UTF-8 y evita
 * que las tildes salgan como garabatos.
 */
function descargarCsv(nombre: string, cabecera: readonly string[], filas: readonly string[][]): void {
  const escapar = (celda: string) => `"${celda.replace(/"/g, '""')}"`;
  const texto =
    '﻿' +
    [cabecera, ...filas].map((fila) => fila.map(escapar).join(';')).join('\r\n');

  const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();

  // Revocar en el siguiente turno del navegador y no aquí mismo.
  //
  // `click()` solo AGENDA la descarga; el navegador lee el blob después. Con
  // archivos pequeños revocar en la misma línea suele alcanzar a funcionar,
  // pero es una carrera: si el archivo crece o la máquina va cargada, la URL
  // ya no existe cuando el navegador va a leerla y la descarga se cancela sin
  // decir nada — el usuario hace clic y no pasa absolutamente nada.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
