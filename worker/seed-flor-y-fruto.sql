-- ============================================================================
--  Bloque: Hortalizas de Flor y de Fruto · Oriente antioqueño
--
--  Notas de datos (no son cosmética, condicionan si el producto se ve):
--  · `categoria_id` va como 'verduras' y no como 'vegetales-fruto'. La tienda
--    filtra con `product.categoryId !== category` contra la lista cerrada de
--    `CATEGORIES` (verduras, frutas, listos, granos, despensa, canastas). Una
--    categoría fuera de esa lista deja el producto visible solo en "Todo el
--    huerto" e invisible bajo cualquier chip. La subdivisión flor/fruto vive
--    en este comentario, que es donde no rompe nada.
--  · El dinero es INTEGER en pesos. Nunca REAL.
--  · `badge` solo admite: nuevo, bestseller, temporada, ultimas-unidades.
--  · `unidad` solo admite: kg, libra, unidad, manojo, canasta, bolsa, frasco.
-- ============================================================================

INSERT INTO products (id, slug, nombre, tagline, categoria_id, grupo_admin, precio, precio_costo, precio_anterior, unidad, origen, rating, review_count, badge, stock_actual, stock_seguridad, imagen, imagen_hover, imagen_alt) VALUES

-- ─────────────────────── Hortalizas de flor ───────────────────────

('p-20201', 'brocoli', 'Brócoli', 'Cabezas apretadas, cortadas con el tallo tierno', 'verduras', 'verduras', 5500, 3900, NULL, 'kg', 'Finca La Milagrosa · Marinilla', 4.7, 132, NULL, 40, 15,
'https://images.unsplash.com/photo-1459411621453-7b03977f4bfc?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1557844352-761f2565b576?auto=format&fit=crop&w=900&h=1125&q=80',
'Cabezas de brócoli verde oscuro con los tallos hacia arriba'),

('p-20202', 'calabacines-con-flor', 'Calabacines con Flor', 'Se cortan con la flor puesta, el mismo día del despacho', 'verduras', 'verduras', 6800, 4900, NULL, 'kg', 'Finca El Rosal · El Carmen de Viboral', 4.8, 64, 'temporada', 18, 10,
'https://images.unsplash.com/photo-1580910051074-3eb694886505?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1557844352-761f2565b576?auto=format&fit=crop&w=900&h=1125&q=80',
'Calabacines verdes pequeños con su flor amarilla todavía unida'),

('p-20203', 'coliflor', 'Coliflor', 'Blanca y compacta, sin manchas de sol', 'verduras', 'verduras', 5200, 3600, NULL, 'unidad', 'Finca La Milagrosa · Marinilla', 4.6, 88, NULL, 32, 12,
'https://images.unsplash.com/photo-1568584711271-6c929fb49b60?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1510627498534-cf7e9002facc?auto=format&fit=crop&w=900&h=1125&q=80',
'Una coliflor blanca entera envuelta en sus hojas verdes'),

-- ─────────────────────── Hortalizas de fruto ───────────────────────

('p-20301', 'ahuyama', 'Ahuyama', 'De pulpa naranja intensa, dulce para sopas y purés', 'verduras', 'verduras', 3200, 2200, NULL, 'kg', 'Finca El Peñol · Antioquia', 4.7, 145, NULL, 60, 20,
'https://images.unsplash.com/photo-1570586437263-ab629fccc818?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1509622905150-fa66d3906e09?auto=format&fit=crop&w=900&h=1125&q=80',
'Ahuyamas enteras de cáscara naranja apiladas sobre madera'),

('p-20302', 'berenjena', 'Berenjena', 'Piel morada brillante, firme al tacto', 'verduras', 'verduras', 4800, 3400, NULL, 'kg', 'Finca Santa Elena · Rionegro', 4.5, 71, NULL, 28, 12,
'https://images.unsplash.com/photo-1615484477778-ca3b77940c25?auto=format&fit=crop&w=900&h=1125&q=80',
NULL,
'Berenjenas moradas de piel brillante con el cáliz verde'),

('p-20303', 'chocolo', 'Chócolo', 'Mazorca tierna, con el grano todavía lechoso', 'verduras', 'verduras', 2500, 1700, NULL, 'unidad', 'Finca La Esperanza · San Vicente', 4.8, 203, 'bestseller', 90, 25,
'https://images.unsplash.com/photo-1551754655-cd27e38d2076?auto=format&fit=crop&w=900&h=1125&q=80',
NULL,
'Mazorcas de maíz amarillo con sus hojas verdes abiertas'),

('p-20304', 'cidras', 'Cidras', 'La base de la sopa antioqueña de toda la vida', 'verduras', 'verduras', 2800, 1900, NULL, 'kg', 'Finca El Rosal · El Carmen de Viboral', 4.4, 56, NULL, 45, 15,
'https://images.unsplash.com/photo-1449300079323-02e209d9d3a6?auto=format&fit=crop&w=900&h=1125&q=80',
NULL,
'Cidras verdes de piel lisa agrupadas en un canasto'),

('p-20305', 'cidra-bebe', 'Cidra Bebé', 'Cosechada pequeña: se cocina entera, sin pelar', 'verduras', 'verduras', 3600, 2500, NULL, 'kg', 'Finca El Rosal · El Carmen de Viboral', 4.6, 38, 'nuevo', 16, 8,
'https://images.unsplash.com/photo-1449300079323-02e209d9d3a6?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1557844352-761f2565b576?auto=format&fit=crop&w=900&h=1125&q=80',
'Cidras verdes muy pequeñas sostenidas en la palma de una mano'),

('p-20306', 'pepino-cohombro', 'Pepino Cohombro', 'Largo, de piel fina y semilla mínima', 'verduras', 'verduras', 3400, 2300, NULL, 'kg', 'Finca Santa Elena · Rionegro', 4.7, 168, NULL, 52, 18,
'https://images.unsplash.com/photo-1604977042946-1eecc30f269e?auto=format&fit=crop&w=900&h=1125&q=80',
NULL,
'Pepinos cohombro verdes y alargados alineados sobre una tabla'),

('p-20307', 'pepino-de-rellenar', 'Pepino de Rellenar', 'Grueso y hueco por dentro, hecho para el horno', 'verduras', 'verduras', 3900, 2700, NULL, 'kg', 'Finca Santa Elena · Rionegro', 4.5, 42, NULL, 24, 10,
'https://images.unsplash.com/photo-1449300079323-02e209d9d3a6?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1604977042946-1eecc30f269e?auto=format&fit=crop&w=900&h=1125&q=80',
'Pepinos gruesos de piel clara partidos por la mitad'),

('p-20308', 'pimenton', 'Pimentón', 'Rojo, amarillo y verde en la misma bolsa', 'verduras', 'verduras', 4500, 3200, 5200, 'kg', 'Finca La Milagrosa · Marinilla', 4.8, 291, 'bestseller', 48, 20,
'https://images.unsplash.com/photo-1563565375-f3fdfdbefa83?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1526470498-9ae73c665de8?auto=format&fit=crop&w=900&h=1125&q=80',
'Pimentones rojos, amarillos y verdes agrupados por color'),

('p-20309', 'aji-dulce', 'Ají Dulce', 'Aroma de ají sin nada de picante', 'verduras', 'verduras', 9800, 7000, NULL, 'libra', 'Finca La Esperanza · San Vicente', 4.6, 47, NULL, 12, 6,
'https://images.unsplash.com/photo-1583119022894-919a68a3d0e3?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1526470498-9ae73c665de8?auto=format&fit=crop&w=900&h=1125&q=80',
'Ajíes dulces pequeños de colores rojo, naranja y verde'),

-- ─────────────────────── Tomates y zucchinis ───────────────────────

('p-20310', 'tomate-cherry', 'Tomate Cherry', 'Se revientan dulces, sin agua de por medio', 'verduras', 'verduras', 9900, 7200, NULL, 'kg', 'Finca La Ceja · Antioquia', 4.9, 356, 'bestseller', 22, 12,
'https://images.unsplash.com/photo-1592841200221-a6898f307baa?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1561136594-7f68413baa99?auto=format&fit=crop&w=900&h=1125&q=80',
'Tomates cherry rojos y pequeños desbordando un cuenco'),

('p-20311', 'tomate-de-mesa', 'Tomate de Mesa', 'El de siempre: para la ensalada y el guiso diario', 'verduras', 'verduras', 4200, 2900, NULL, 'kg', 'Finca La Ceja · Antioquia', 4.5, 224, NULL, 70, 25,
'https://images.unsplash.com/photo-1546094096-0df4bcaaa337?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1592924357228-91a4daadcfea?auto=format&fit=crop&w=900&h=1125&q=80',
'Tomates rojos maduros unidos por su rama verde'),

('p-20312', 'tomates-variedad', 'Tomates Variedad', 'Cuatro colores en la misma caja, ninguno igual', 'verduras', 'verduras', 7500, 5400, 8900, 'kg', 'Finca La Ceja · Antioquia', 4.7, 96, 'temporada', 15, 8,
'https://images.unsplash.com/photo-1561136594-7f68413baa99?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1592841200221-a6898f307baa?auto=format&fit=crop&w=900&h=1125&q=80',
'Tomates de distintos tamaños y colores repartidos sobre una superficie oscura'),

('p-20313', 'zucchini-verde', 'Zucchini Verde', 'Recto y firme, del tamaño justo para la sartén', 'verduras', 'verduras', 4900, 3400, NULL, 'kg', 'Finca El Rosal · El Carmen de Viboral', 4.6, 118, NULL, 38, 15,
'https://images.unsplash.com/photo-1580910051074-3eb694886505?auto=format&fit=crop&w=900&h=1125&q=80',
NULL,
'Zucchinis verdes alargados con la piel brillante'),

('p-20314', 'zucchini-amarillo', 'Zucchini Amarillo', 'Mismo sabor que el verde, con la piel más delgada', 'verduras', 'verduras', 5400, 3800, NULL, 'kg', 'Finca El Rosal · El Carmen de Viboral', 4.5, 61, 'nuevo', 20, 10,
'https://images.unsplash.com/photo-1580910051074-3eb694886505?auto=format&fit=crop&w=900&h=1125&q=80',
'https://images.unsplash.com/photo-1509622905150-fa66d3906e09?auto=format&fit=crop&w=900&h=1125&q=80',
'Zucchinis amarillos alargados junto a otros verdes');
