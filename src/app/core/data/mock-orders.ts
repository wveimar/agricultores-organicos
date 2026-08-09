import { Order } from '../models/order.model';

/**
 * Pedidos simulados. Las cantidades están pensadas para que el panel tenga
 * casos interesantes desde el primer arranque:
 *
 * - `ORD-1043` pide 12 aguacates y solo hay 6 → aprobarlo debe **fallar** y
 *   mostrar el faltante, sin tocar el inventario.
 * - El resto se aprueba sin problema y descuenta unidades de verdad.
 */
export const ORDERS: readonly Order[] = [
  {
    id: 'o-01',
    reference: 'ORD-1041',
    customerName: 'Marcela Ospina',
    customerEmail: 'marcela.ospina@correo.com',
    city: 'Bogotá',
    placedAt: '2026-08-09T08:14:00.000Z',
    status: 'pendiente',
    lines: [
      { productId: 'p-24', productName: 'Canasta Semanal Familiar', unitPrice: 89_000, quantity: 1 },
      { productId: 'p-22', productName: 'Café de Origen · Tueste Medio', unitPrice: 32_000, quantity: 2 },
    ],
  },
  {
    id: 'o-02',
    reference: 'ORD-1042',
    customerName: 'Julián Restrepo',
    customerEmail: 'j.restrepo@correo.com',
    city: 'Medellín',
    placedAt: '2026-08-09T09:02:00.000Z',
    status: 'pendiente',
    lines: [
      { productId: 'p-09', productName: 'Fresa de Temporada', unitPrice: 12_900, quantity: 3 },
      { productId: 'p-23', productName: 'Miel de Abeja Cruda', unitPrice: 28_500, quantity: 1 },
      { productId: 'p-03', productName: 'Papa Nativa de Páramo', unitPrice: 7_200, quantity: 4 },
    ],
  },
  {
    id: 'o-03',
    reference: 'ORD-1043',
    customerName: 'Restaurante La Huerta',
    customerEmail: 'compras@lahuerta.co',
    city: 'Bogotá',
    placedAt: '2026-08-09T10:35:00.000Z',
    status: 'pendiente',
    lines: [
      // Supera el stock disponible (6): sirve para probar el bloqueo.
      { productId: 'p-05', productName: 'Aguacate Hass', unitPrice: 4_900, quantity: 12 },
      { productId: 'p-01', productName: 'Tomate Chonto en Rama', unitPrice: 9_800, quantity: 5 },
    ],
  },
  {
    id: 'o-04',
    reference: 'ORD-1039',
    customerName: 'Ana Lucía Peña',
    customerEmail: 'analucia@correo.com',
    city: 'Cali',
    placedAt: '2026-08-08T16:20:00.000Z',
    status: 'aprobado',
    approvedBy: 'Diana Cardona',
    approvedAt: '2026-08-08T17:05:00.000Z',
    lines: [
      { productId: 'p-13', productName: 'Cítricos y Tropicales', unitPrice: 26_900, quantity: 2 },
    ],
  },
  {
    id: 'o-05',
    reference: 'ORD-1038',
    customerName: 'Hotel Campestre El Roble',
    customerEmail: 'recepcion@elroble.co',
    city: 'Villa de Leyva',
    placedAt: '2026-08-08T11:48:00.000Z',
    status: 'enviado',
    approvedBy: 'Diana Cardona',
    approvedAt: '2026-08-08T12:30:00.000Z',
    lines: [
      { productId: 'p-25', productName: 'Canasta del Mercado · Grande', unitPrice: 146_000, quantity: 1 },
      { productId: 'p-20', productName: 'Trigo Integral Molido en Piedra', unitPrice: 9_600, quantity: 6 },
    ],
  },
  {
    id: 'o-06',
    reference: 'ORD-1044',
    customerName: 'Camilo Vargas',
    customerEmail: 'camilo.vargas@correo.com',
    city: 'Bucaramanga',
    placedAt: '2026-08-09T11:12:00.000Z',
    status: 'pendiente',
    lines: [
      { productId: 'p-15', productName: 'Ensalada Arcoíris', unitPrice: 16_900, quantity: 2 },
      { productId: 'p-18', productName: 'Smoothie de Fresa y Chía', unitPrice: 11_200, quantity: 2 },
    ],
  },
];
