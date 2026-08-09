/**
 * Fotografías del catálogo (Unsplash, sin API key).
 *
 * Cada ID fue verificado con una petición HEAD (200 OK) **y revisado
 * visualmente** antes de asignarlo: el nombre de la constante describe lo que
 * la foto muestra de verdad. Si cambias un ID, mira la imagen primero — el
 * nombre y el `imageAlt` del producto dependen de que la descripción sea real.
 */
const ID = {
  papas: '1518977676601-b53f82aba655',
  ensaladaColorida: '1540420773420-3366772f4999',
  manzanas: '1567306226416-28f0efdc88ce',
  frutaTropical: '1610832958506-aa56368176cf',
  puestoVerdurasVerdes: '1557844352-761f2565b576',
  tomatesEnRama: '1546094096-0df4bcaaa337',
  bowlAguacate: '1512621776951-a57141f2eefd',
  bowlHuevoRabano: '1490645935967-10de6ba17061',
  smoothieFresa: '1502741224143-90386d7f8c82',
  granosCafe: '1447933601403-0c6688de566e',
  sandia: '1587049352846-4a222e784d38',
  mielFrasco: '1558642452-9d2a7deb7f62',
  mercadoColorido: '1550989460-0adf9ea622e2',
  verdurasFondoNegro: '1518843875459-f738682238a6',
  especiasSemillas: '1596040033229-a9821ebd058d',
  puestoZanahorias: '1471193945509-9ad0617afabf',
  bowlCocoFrutas: '1519996529931-28324d5a630e',
  fresas: '1464965911861-746a04b4bca6',
  verdurasEnCirculo: '1610348725531-843dff563e2c',
  granosTrigo: '1574323347407-f5e1ad6d020b',
  guisoVerduras: '1596797038530-2c107229654b',
  mangos: '1601493700631-2b16ec4b4716',
  medioAguacate: '1523049673857-eb18f1d7b578',
  tomateFondoVerde: '1607305387299-a3d9611cd469',
  bananos: '1571771894821-ce9b6c11b08e',
  tomatesFondoOscuro: '1592924357228-91a4daadcfea',
} as const;

export type ImageKey = keyof typeof ID;

/** URL recortada al ratio 4:5 que usa la tarjeta de producto. */
export function photo(key: ImageKey, width = 900): string {
  return `https://images.unsplash.com/photo-${ID[key]}?auto=format&fit=crop&w=${width}&h=${Math.round(
    (width * 5) / 4,
  )}&q=80`;
}

/** URL apaisada para el hero y las bandas editoriales. */
export function wide(key: ImageKey, width = 1800, ratio = 2.4): string {
  return `https://images.unsplash.com/photo-${ID[key]}?auto=format&fit=crop&w=${width}&h=${Math.round(
    width / ratio,
  )}&q=80`;
}
