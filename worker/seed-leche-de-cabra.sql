-- ============================================================================
--  Sección: Leche de cabra · derivados de un hato pequeño
--
--  Notas de datos:
--  · `categoria_id` = 'lacteos'. Está dado de alta en los tres sitios que hacen
--    falta para que la sección exista de verdad: la unión `CategoryId`, la
--    lista `CATEGORIES` (que pinta el chip de la vitrina) y `ADMIN_GROUP_OF`.
--    Sembrar una categoría que no esté en esos tres deja el producto visible
--    solo en "Todo el huerto".
--  · `grupo_admin` = 'agroindustriales'. Es obligatorio: el CHECK de D1 solo
--    admite frutas, verduras y agroindustriales.
--  · `unidad` sale de la lista cerrada de `ProductUnit`; no hay 'litro', así
--    que la leche y el yogur van en 'bolsa' y 'frasco', que es como se
--    entregan.
--  · El dinero es INTEGER en pesos. Precios de cabra, que están por encima de
--    los de vaca: el hato es pequeño y el ordeño es a mano.
-- ============================================================================

INSERT INTO products (id, slug, nombre, tagline, categoria_id, grupo_admin, precio, precio_costo, precio_anterior, unidad, origen, rating, review_count, badge, stock_actual, stock_seguridad, imagen, imagen_hover, imagen_alt) VALUES

('p-20401', 'leche-de-cabra', 'Leche de Cabra', 'Ordeñada por la mañana y enfriada de inmediato', 'lacteos', 'agroindustriales', 8500, 6200, NULL, 'bolsa', 'Hato La Palma · Santa Elena', 4.8, 96, 'nuevo', 40, 15,
'https://images.unsplash.com/photo-1563636619-e9143da7973b?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1550583724-b2692b85b150?auto=format&fit=crop&w=900&h=1125&q=80',
'Botella de vidrio con leche sobre una superficie clara'),

('p-20402', 'yogur-de-cabra-con-fruta', 'Yogur de Cabra con Fruta', 'Fermentado tres días, con fruta de las mismas fincas', 'lacteos', 'agroindustriales', 11500, 8100, NULL, 'frasco', 'Hato La Palma · Santa Elena', 4.9, 142, 'bestseller', 26, 12,
'https://images.unsplash.com/photo-1488477181946-6428a0291777?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1571212515416-fef01fc43637?auto=format&fit=crop&w=900&h=1125&q=80',
'Frasco de yogur blanco con fruta roja encima'),

('p-20403', 'cuajada-de-cabra', 'Cuajada de Cabra', 'Sin prensar y sin sal: se come el mismo día', 'lacteos', 'agroindustriales', 12000, 8400, NULL, 'libra', 'Hato La Palma · Santa Elena', 4.7, 68, NULL, 14, 8,
'https://images.unsplash.com/photo-1559561853-08451507cbe7?auto=format&fit=crop&w=900&h=1125&q=80',
NULL,
'Cuajada blanca fresca escurriendo en un lienzo'),

('p-20404', 'queso-fresco-de-cabra', 'Queso Fresco de Cabra', 'Suave y untable, listo a los dos días', 'lacteos', 'agroindustriales', 14500, 10200, NULL, 'libra', 'Hato La Palma · Santa Elena', 4.8, 187, NULL, 22, 10,
'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1452195100486-9cc805987862?auto=format&fit=crop&w=900&h=1125&q=80',
'Trozo de queso blanco fresco cortado sobre una tabla'),

('p-20405', 'queso-maduro-de-cabra', 'Queso Maduro de Cabra', 'Cuatro meses en cava; el sabor se concentra solo', 'lacteos', 'agroindustriales', 28000, 19600, 32000, 'libra', 'Hato La Palma · Santa Elena', 4.9, 74, 'temporada', 9, 5,
'https://images.unsplash.com/photo-1452195100486-9cc805987862?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1631379578550-7038263db699?auto=format&fit=crop&w=900&h=1125&q=80',
'Cuñas de queso curado de corteza oscura sobre una tabla de madera');
