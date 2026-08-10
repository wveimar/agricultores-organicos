/**
 * Hook de resolución para poder importar el código fuente de Angular desde
 * Node sin compilarlo.
 *
 * TypeScript escribe los imports relativos sin extensión (`'../models/x'`),
 * que es lo normal cuando hay bundler, pero el resolvedor ESM de Node exige la
 * extensión explícita. Este hook reintenta añadiendo `.ts` cuando la
 * resolución normal falla.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
