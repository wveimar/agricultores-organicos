---
name: test-qa
description: >-
  Ejecuta la suite de pruebas QA end-to-end del proyecto Agricultores Orgánicos
  contra el Worker local y D1 local. Usar para verificar integridad de datos,
  seguridad, flujos de pedidos, consolidados y reglas de negocio después de
  migraciones o cambios en la API.
metadata:
  category: testing
  suggest_for:
    filename:
      - 'worker/tests/qa-*.mjs'
      - 'worker/tests/qa-*.sql'
  source:
    repository: 'local'
    path: worker/tests
---

# QA Suite — Agricultores Orgánicos (solo local)

Ejecuta pruebas automatizadas contra Cloudflare D1 local y el Worker local
para validar reglas de negocio, seguridad y flujos críticos.

## Prerrequisitos

1. Worker corriendo en local (puerto 8788):
   ```bash
   npm run worker:dev
   ```
2. Base de datos local sembrada y con el schema actualizado:
   ```bash
   npm run db:reset
   ```
3. No cerrar el Worker mientras se ejecutan las pruebas MJS.

## Suites de prueba

### 1. Integridad de datos (D1 local)

```bash
npm run qa:fk:valid
```
Verifica que las claves foráneas se respetan al crear un pedido válido.

```bash
npm run qa:fk:invalid
```
Verifica que D1 local rechaza un pedido con producto inexistente.

### 2. Seguridad

```bash
npm run qa:seguridad
```

Valida:
- Autenticación requerida en rutas protegidas.
- Tokens inválidos rechazados.
- `password_hash` nunca expuesto en respuestas.
- Rate limiting por IP y email.

### 3. Usuarios y roles

```bash
npm run qa:usuarios
```

Cubre:
- Creación de usuario con roles (`ADMIN_INVENTARIO`, `GESTOR_PEDIDOS`, `SUPER_ADMIN`).
- Edición de nombre y roles.
- Activación/desactivación.

### 4. Fuerza bruta

```bash
npm run qa:fuerza-bruta
```

Verifica que `login_attempts` bloquea después de N intentos fallidos.

### 5. Stock y descuentos

```bash
npm run qa:stock
```

Valida que:
- No se puede aprobar un pedido con stock insuficiente.
- El stock se descuenta al aprobar.
- Al cancelar, el stock se devuelve.

### 6. Destacados y borrado

```bash
npm run qa:destacados
```

Verifica que marcar/desmarcar como destacado persiste y que borrar un producto
con pedidos asociados falla con el código correcto.

### 7. Consolidado semanal

```bash
npm run qa:consolidado
```

Cubre:
- El consolidado agrupa por `grupo_admin`.
- Los totales coinciden con los pedidos aprobados.
- La copia para WhatsApp incluye las presentaciones correctas.

### 8. Edición de pedidos

```bash
npm run qa:editar-pedido
```

Verifica que modificar líneas de un pedido ajusta el stock y que no se pueden
añadir cantidades mayores a las disponibles.

### 9. Duplicar producto

```bash
npm run qa:duplicar
```

Valida que la copia nace inactiva, sin stock y con el mismo `categoria_id` y
`grupo_admin`.

### 10. Cancelación

```bash
npm run qa:cancelacion
```

Verifica que al cancelar:
- El stock reservado se devuelve.
- El estado pasa a `cancelado`.
- No se puede cancelar dos veces el mismo pedido.

### 11. Recuperación de contraseña

```bash
npm run qa:recuperacion
```

Cubre:
- Solicitar reset devuelve 200 siempre.
- El token funciona para cambiar la contraseña.
- Un token inválido es rechazado.

### 12. Mayoristas

```bash
npm run qa:mayoristas
```

Valida las reglas de negocio específicas de clientes mayoristas.

## Ejecutar todo (local)

Orden recomendado: de menor a mayor dependencia.

```bash
npm run qa:seguridad
npm run qa:fk:valid
npm run qa:fk:invalid
npm run qa:stock
npm run qa:destacados
npm run qa:duplicar
npm run qa:editar-pedido
npm run qa:cancelacion
npm run qa:usuarios
npm run qa:recuperacion
npm run qa:fuerza-bruta
npm run qa:consolidado
npm run qa:mayoristas
```

## Limpiar después de pruebas

```bash
npm run qa:cleanup
```

## Troubleshooting

- **Puerto 8788 ocupado:** Detén el Worker o cambia el puerto con `wrangler dev --port <otro>`.
- **D1 no responde:** Asegúrate de haber corrido `npm run db:schema` primero.
- **Tests MJS fallan con 404:** El Worker no está corriendo o la ruta no existe en la versión local.
- **Pruebas FK fallan:** Revisa que el schema tenga las FK correctas y que `PRAGMA foreign_keys = ON` esté activo.
