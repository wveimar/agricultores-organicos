import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { ApiCuentaTesoreria, ApiErrorBody, ApiTurnoCaja, ApiTurnoCerrado } from '../../../../core/api/api-client';
import { CopPipe } from '../../../../shared/pipes/cop.pipe';

/**
 * Todo lo que necesita UNA tarjeta de cuenta: su turno, su historial, y —solo
 * para la que sea efectivo— el número que hay que contar a mano.
 *
 * `notas`/`recibeUsuario`/`recibeClave` NO viven aquí: son del cierre, y el
 * cierre ahora es UNA sola firma para todas las cuentas que se cierran a la
 * vez, no una por cuenta. Vive más abajo, a nivel de pantalla.
 */
interface EstadoCuenta {
  readonly turno: ApiTurnoCaja | null;
  readonly historial: readonly ApiTurnoCerrado[];
  readonly cargando: boolean;
  readonly error: string | null;
  readonly hecho: string | null;
  // Apertura (solo lo usa la cuenta de efectivo).
  readonly fondoApertura: number;
  // Arqueo (solo lo usa la cuenta de efectivo).
  readonly efectivoContado: number | null;
  readonly vouchers: number;
}

const ESTADO_INICIAL: EstadoCuenta = {
  turno: null,
  historial: [],
  cargando: false,
  error: null,
  hecho: null,
  fondoApertura: 0,
  efectivoContado: null,
  vouchers: 0,
};

/**
 * El turno de cada cajero, con cuánto abrió, cuánto contó al cerrar, y en
 * cuánto falló — de LAS DOS cuentas a la vez.
 *
 * ── Por qué las dos cuentas a la vez y no un selector ──
 *
 * Antes había un botoncito para elegir «Caja (efectivo)» o «Cuenta bancaria»
 * y la pantalla mostraba solo una. En la práctica el cajero necesita ver las
 * dos: abre turno en la caja física, pero la cuenta bancaria también corre su
 * propio turno del día, y saber si está cuadrada no debería costar un clic
 * extra ni perder de vista la otra mientras se está mirando esta. Por eso cada
 * cuenta tiene su propio estado (turno, arqueo, formulario) y las dos se
 * pintan una junto a la otra.
 *
 * ── Por qué la apertura es UN botón y no dos ──
 *
 * El efectivo es un objeto físico: nadie sabe con certeza cuánto hay en el
 * cajón hasta que alguien lo cuenta, y por eso «fondo de apertura» le pide un
 * número escrito a mano. La cuenta bancaria no tiene ese problema — su saldo
 * no se cuenta, el sistema ya lo sabe con exactitud — así que pedirle el mismo
 * número a mano no solo sobra, sino que si se deja en 0 (lo natural) el
 * «esperado» de ese turno queda mintiendo desde el primer segundo. Por eso
 * `abrirTodo()` abre las DOS con un solo clic: al efectivo le pide lo que el
 * cajero cuenta, y al banco le da directamente su saldo actual, sin campo que
 * llenar. Sigue pidiendo la firma de quien recibe en las dos — de la plata
 * bancaria también hay que dejar constancia de quién se hizo responsable del
 * turno, aunque no haya nada que contar.
 *
 * ── Qué NO es esta pantalla ──
 *
 * No es el cierre de jornada. Ese sigue en Reportes y responde «¿cuánto se
 * ganó hoy?» — ventas menos mercancía, gastos y merma. Este responde otra
 * pregunta: «¿cuadró el cajón de esta persona?». Dentro de una jornada caben
 * varios turnos, y por eso conviven sin pisarse.
 *
 * ── Por qué se pide usuario y clave al cerrar ──
 *
 * Porque un turno se ENTREGA. Quien recibe confirma con su clave, y eso
 * convierte el cierre en algo que dos personas firmaron: sin ello, cualquiera
 * podría cerrar un cajón que no contó y dejarle el faltante al siguiente.
 *
 * ── Por qué el cierre también es UN botón y no dos ──
 *
 * Mismo argumento que la apertura, llevado hasta el final: al cerrar, lo único
 * que hay que CONTAR es el efectivo. La cuenta bancaria cierra con
 * `esperado` — su propio cálculo, no un número que alguien teclea — porque no
 * hay manera de que un saldo digital "dé distinto" de lo que la suma de sus
 * movimientos dice que es. Pedirle a alguien que retipee ese mismo número no
 * es una verificación, es copiar un dato que el sistema ya tiene. Lo que SÍ
 * sigue siendo necesario para las dos cuentas es la firma de quien recibe —
 * eso no depende de si hay algo que contar, sino de quién se hace responsable
 * del turno que se cierra.
 */
@Component({
  selector: 'app-tesoreria-cierre',
  standalone: true,
  imports: [CopPipe],
  templateUrl: './tesoreria-cierre.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesoreriaCierre {
  protected readonly admin = inject(AdminApiService);

  /** Una entrada por cuenta, indexada por `cuentaId`. */
  private readonly estados = signal<Record<string, EstadoCuenta>>({});

  constructor() {
    // Reacciona a la lista de cuentas en vez de pedirla en el constructor:
    // el contenedor `Tesoreria` dispara `loadTesoreria()` arriba, y esta
    // pestaña puede montarse antes de que esa respuesta llegue. El `effect`
    // carga el turno de cada cuenta en cuanto aparece, sin volver a pedir las
    // que ya tiene.
    effect(() => {
      for (const cuenta of this.admin.cuentasTesoreria()) {
        if (!(cuenta.id in this.estados())) {
          this.cargar(cuenta.id);
        }
      }
    });
  }

  /** El estado de una cuenta, o el de partida si todavía no se ha pedido. */
  protected estadoDe(cuentaId: string): EstadoCuenta {
    return this.estados()[cuentaId] ?? ESTADO_INICIAL;
  }

  // ── Abrir turno del día, para las cuentas que aún no tienen uno ────────

  /**
   * La cuenta de efectivo, que es la única a la que se le pide un número a
   * mano. Se busca por `tipo` y no por un id fijo: el esquema hoy solo siembra
   * una caja física, pero nada ata este componente a que se llame
   * `caja-efectivo`.
   */
  protected readonly cuentaEfectivo = computed<ApiCuentaTesoreria | null>(
    () => this.admin.cuentasTesoreria().find((c) => c.tipo === 'efectivo') ?? null,
  );

  /** Las cuentas que todavía no tienen turno abierto hoy. */
  protected readonly cuentasSinTurno = computed(() =>
    this.admin.cuentasTesoreria().filter((c) => this.estadoDe(c.id).turno === null),
  );

  protected readonly abriendoTodo = signal(false);
  protected readonly errorAbrirTodo = signal<string | null>(null);

  /**
   * Abre turno en todas las cuentas que aún no lo tienen, en un solo clic.
   *
   * Al efectivo se le pasa lo que el cajero escribió en el campo compartido
   * (lo cuenta él, a mano). Al banco se le pasa `c.saldo` — su saldo actual,
   * ya calculado por el Worker — y NO lo que haya en ese campo, porque ese
   * campo ni siquiera se le muestra: nada que contar, nada que escribir.
   */
  protected abrirTodo(): void {
    const faltan = this.cuentasSinTurno();
    if (faltan.length === 0) return;

    this.abriendoTodo.set(true);
    this.errorAbrirTodo.set(null);

    const peticiones = faltan.map((c) => {
      const fondo = c.tipo === 'efectivo' ? this.estadoDe(c.id).fondoApertura : c.saldo;
      return this.admin.abrirTurno({ cuentaId: c.id, fondoApertura: fondo });
    });

    forkJoin(peticiones).subscribe({
      next: () => {
        this.abriendoTodo.set(false);
        for (const c of faltan) this.cargar(c.id);
      },
      error: (err: ApiErrorBody) => {
        this.abriendoTodo.set(false);
        this.errorAbrirTodo.set(err.message);
        // Alguna de las peticiones ya viajó al Worker antes de que otra
        // fallara: refrescar todas para que la pantalla diga lo que de
        // verdad quedó abierto, no lo que se intentó.
        for (const c of faltan) this.cargar(c.id);
      },
    });
  }

  private actualizar(cuentaId: string, cambios: Partial<EstadoCuenta>): void {
    this.estados.update((mapa) => ({
      ...mapa,
      [cuentaId]: { ...(mapa[cuentaId] ?? ESTADO_INICIAL), ...cambios },
    }));
  }

  protected cargar(cuentaId: string): void {
    this.actualizar(cuentaId, { cargando: true });
    this.admin.tesoreriaTurno(cuentaId).subscribe({
      next: (d) => this.actualizar(cuentaId, { turno: d.turno, historial: d.historial, cargando: false }),
      error: () => this.actualizar(cuentaId, { cargando: false }),
    });
  }

  // ── Los campos del formulario, uno por cuenta ──────────────────────────

  protected setFondoApertura(cuentaId: string, valor: number): void {
    this.actualizar(cuentaId, { fondoApertura: valor });
  }

  protected setEfectivoContado(cuentaId: string, valor: number | null): void {
    this.actualizar(cuentaId, { efectivoContado: valor });
  }

  protected setVouchers(cuentaId: string, valor: number): void {
    this.actualizar(cuentaId, { vouchers: valor });
  }

  /**
   * La diferencia, en vivo mientras se teclea lo contado.
   *
   * Solo puede dar distinto de `null` para la cuenta de efectivo: es la única
   * a la que se le pide `efectivoContado`. La bancaria nunca lo escribe —
   * cierra directo con `esperado` — así que aquí siempre da `null` para ella,
   * y por eso el aviso de «cuadra / falta / sobra» no se muestra en su
   * tarjeta: mostrarlo sería fingir una verificación que no ocurrió.
   *
   * Se muestra ANTES de confirmar a propósito: si apareciera solo después,
   * el cajero descubriría el faltante cuando ya no puede volver a contar.
   */
  protected diferencia(cuentaId: string): number | null {
    const estado = this.estadoDe(cuentaId);
    if (estado.efectivoContado === null || !estado.turno) return null;
    return estado.efectivoContado - estado.turno.esperado;
  }

  // ── Cerrar turno del día, para las cuentas que estén abiertas ──────────

  /** Las cuentas con un turno abierto ahora mismo. */
  protected readonly cuentasAbiertas = computed(() =>
    this.admin.cuentasTesoreria().filter((c) => this.estadoDe(c.id).turno !== null),
  );

  protected readonly cerrarNotas = signal('');
  protected readonly cerrarRecibeUsuario = signal('');
  protected readonly cerrarRecibeClave = signal('');
  protected readonly cerrandoTodo = signal(false);
  protected readonly errorCerrarTodo = signal<string | null>(null);

  protected readonly puedeCerrarTodo = computed(() => {
    const abiertas = this.cuentasAbiertas();
    if (abiertas.length === 0 || this.cerrandoTodo()) return false;

    // Si el efectivo está entre las que se van a cerrar, tiene que estar
    // contado. La bancaria no entra en esta condición: nunca se cuenta.
    const efectivo = this.cuentaEfectivo();
    const efectivoListo =
      !efectivo ||
      !abiertas.some((c) => c.id === efectivo.id) ||
      this.estadoDe(efectivo.id).efectivoContado !== null;

    return efectivoListo && this.cerrarRecibeUsuario().trim() !== '' && this.cerrarRecibeClave() !== '';
  });

  /**
   * Cierra todas las cuentas abiertas, en un solo clic, con una sola firma.
   *
   * Al efectivo se le manda lo que el cajero contó. A la bancaria se le manda
   * su propio `esperado` — nunca lo que haya en `efectivoContado`, porque a
   * ella ni se le pide: no hay campo que llenar, no hay nada que retipear.
   */
  protected cerrarTodo(): void {
    const abiertas = this.cuentasAbiertas();
    if (!this.puedeCerrarTodo()) return;

    this.cerrandoTodo.set(true);
    this.errorCerrarTodo.set(null);

    const peticiones = abiertas.map((c) => {
      const estado = this.estadoDe(c.id);
      const efectivoContado = c.tipo === 'efectivo' ? (estado.efectivoContado ?? 0) : (estado.turno?.esperado ?? 0);
      const vouchers = c.tipo === 'efectivo' ? estado.vouchers : 0;

      return this.admin.cerrarTurno({
        cuentaId: c.id,
        efectivoContado,
        vouchersContados: vouchers,
        notas: this.cerrarNotas().trim() || undefined,
        recibeUsuario: this.cerrarRecibeUsuario().trim(),
        recibeClave: this.cerrarRecibeClave(),
      });
    });

    forkJoin(peticiones).subscribe({
      next: (resultados) => {
        this.cerrandoTodo.set(false);
        // `forkJoin` conserva el orden: el resultado i-ésimo es el de
        // `abiertas[i]`, así cada tarjeta se entera de SU propio cierre.
        resultados.forEach((t, i) => {
          const cuentaId = abiertas[i].id;
          this.actualizar(cuentaId, {
            hecho:
              t.diferencia === 0
                ? `Turno ${t.referencia} cerrado y cuadrado.`
                : `Turno ${t.referencia} cerrado con una diferencia de ${t.diferencia}.`,
            efectivoContado: null,
            vouchers: 0,
          });
          this.cargar(cuentaId);
        });
        this.cerrarNotas.set('');
        this.cerrarRecibeUsuario.set('');
        this.cerrarRecibeClave.set('');
      },
      error: (err: ApiErrorBody) => {
        this.cerrandoTodo.set(false);
        this.errorCerrarTodo.set(err.message);
        // Igual que en `abrirTodo()`: alguna petición ya pudo llegar al
        // Worker antes de que otra fallara, así que se refresca todo.
        for (const c of abiertas) this.cargar(c.id);
      },
    });
  }

  protected fechaHora(iso: string): string {
    const d = new Date((iso ?? '').replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return iso ?? '';
    return d.toLocaleString('es-CO', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
