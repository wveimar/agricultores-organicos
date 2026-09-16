import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ProductSession } from '../../core/models/product.model';

/** Una celda del mes: su fecha, si pertenece al mes que se mira, y qué sesiones caen ese día. */
interface DayCell {
  readonly date: Date;
  readonly key: string;
  readonly inMonth: boolean;
  readonly isPast: boolean;
  readonly sessions: readonly ProductSession[];
}

const DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** "2026-09-14", en la zona horaria local — la clave con la que se agrupan las sesiones por día. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Calendario de disponibilidad de un producto-servicio: un mes, con los días
 * que tienen alguna sesión resaltados. Un día con una sola sesión la elige
 * directamente; con varias (dos horarios el mismo día), despliega la lista
 * de horas debajo para que se elija cuál.
 *
 * Sin librería externa a propósito — mismo criterio que el resto de la
 * interfaz (los íconos de `CategoryIcon`, el ciclo de `ordering-window.ts`):
 * es aritmética de fechas sencilla, y una dependencia nueva no compensa.
 */
@Component({
  selector: 'app-tour-calendar',
  templateUrl: './tour-calendar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TourCalendar {
  readonly sessions = input.required<readonly ProductSession[]>();
  readonly selectedId = input<string | null>(null);

  /** Emite el id de la sesión elegida. */
  readonly select = output<string>();

  protected readonly dias = DIAS;

  private readonly today = startOfDay(new Date());

  /** Primer día del mes que se está mirando. Arranca en el mes de hoy. */
  protected readonly viewMonth = signal(new Date(this.today.getFullYear(), this.today.getMonth(), 1));

  protected readonly monthLabel = computed(() => {
    const m = this.viewMonth();
    return `${MESES[m.getMonth()]} ${m.getFullYear()}`;
  });

  /** Sesiones agrupadas por día, en la zona horaria local del navegador. */
  private readonly byDay = computed(() => {
    const map = new Map<string, ProductSession[]>();
    for (const session of this.sessions()) {
      const key = dayKey(new Date(session.start));
      const list = map.get(key);
      if (list) {
        list.push(session);
      } else {
        map.set(key, [session]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start.localeCompare(b.start));
    }
    return map;
  });

  /** No se puede retroceder antes del mes de hoy: una sesión pasada no se reserva. */
  protected readonly canGoBack = computed(() => {
    const m = this.viewMonth();
    return m.getFullYear() > this.today.getFullYear() || m.getMonth() > this.today.getMonth();
  });

  /** Cuadrícula de 6×7, semana de lunes a domingo, con relleno del mes anterior/siguiente. */
  protected readonly weeks = computed<readonly (readonly DayCell[])[]>(() => {
    const first = this.viewMonth();
    const byDay = this.byDay();

    // `getDay()`: domingo = 0. Se convierte a "días desde el lunes" para que
    // la cuadrícula empiece en lunes, como el resto de la interfaz
    // (`ordering-window.ts` hace la misma conversión).
    const startOffset = (first.getDay() + 6) % 7;
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - startOffset);

    const cells: DayCell[] = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + i);
      const key = dayKey(date);
      cells.push({
        date,
        key,
        inMonth: date.getMonth() === first.getMonth(),
        isPast: date < this.today,
        sessions: byDay.get(key) ?? [],
      });
    }

    const weeks: DayCell[][] = [];
    for (let i = 0; i < 42; i += 7) {
      weeks.push(cells.slice(i, i + 7));
    }
    return weeks;
  });

  /** El día expandido para elegir hora, cuando tiene más de una sesión. */
  protected readonly expandedDay = signal<string | null>(null);

  protected readonly expandedSessions = computed(() => {
    const key = this.expandedDay();
    return key ? (this.byDay().get(key) ?? []) : [];
  });

  protected disponible(session: ProductSession): boolean {
    return session.capacityAvailable > 0;
  }

  protected hasAvailability(cell: DayCell): boolean {
    return cell.sessions.some((s) => this.disponible(s));
  }

  protected pickDay(cell: DayCell): void {
    if (!cell.inMonth || cell.isPast || !this.hasAvailability(cell)) {
      return;
    }
    const disponibles = cell.sessions.filter((s) => this.disponible(s));
    if (disponibles.length === 1) {
      this.expandedDay.set(cell.key);
      this.select.emit(disponibles[0].id);
      return;
    }
    // Varias horas ese día: se despliegan debajo, sin elegir ninguna todavía.
    this.expandedDay.set(this.expandedDay() === cell.key ? null : cell.key);
  }

  protected pickSession(sessionId: string): void {
    this.select.emit(sessionId);
  }

  protected hora(session: ProductSession): string {
    return new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(
      new Date(session.start),
    );
  }

  protected prevMonth(): void {
    if (!this.canGoBack()) {
      return;
    }
    const m = this.viewMonth();
    this.viewMonth.set(new Date(m.getFullYear(), m.getMonth() - 1, 1));
  }

  protected nextMonth(): void {
    const m = this.viewMonth();
    this.viewMonth.set(new Date(m.getFullYear(), m.getMonth() + 1, 1));
  }
}
