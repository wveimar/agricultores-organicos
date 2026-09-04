

-- ─────────────────────────── Productos ───────────────────────────
INSERT INTO products (id, slug, nombre, tagline, categoria_id, grupo_admin, precio, precio_costo, precio_anterior, unidad, origen, rating, review_count, badge, stock_actual, stock_seguridad, imagen, imagen_hover, imagen_alt) VALUES
-- Acelga
('p-20101', 'acelga-fresca', 'Acelga', 'Hojas verdes y tallos tiernos', 'verduras', 'verduras', 3500, 2400, NULL, 'kg', 'Finca Marinilla · Antioquia', 4.5, 42, 'nuevo', 25, 10, 
'https://images.unsplash.com/photo-1590779033100-9f60705a2f3d?auto=format&fit=crop&w=900&h=1125&q=80', 
'https://images.unsplash.com/photo-1515471204579-f30b05024798?auto=format&fit=crop&w=900&h=1125&q=80', 
'Mojo de acelgas verdes frescas con tallos blancos brillantes'),

-- Apio
('p-20102', 'apio-ensalada', 'Apio de Ensalada', 'Crocante y refrescante para jugos o ensaladas', 'verduras', 'verduras', 4200, 3100, 4800, 'kg', 'Finca Marinilla · Antioquia', 4.7, 85, NULL, 15, 5, 
'https://images.unsplash.com/photo-1444418185997-114f602484e6?auto=format&fit=crop&w=900&h=1125&q=80', 
'https://images.unsplash.com/photo-1597843786411-a7fa8ad44a95?auto=format&fit=crop&w=900&h=1125&q=80', 
'Tallos de apio verde claro dispuestos verticalmente'),

-- Lechuga Batavia
('p-20111', 'lechuga-batavia', 'Lechuga Batavia', 'La base perfecta para tus ensaladas diarias', 'verduras', 'verduras', 2800, 1900, NULL, 'unidad', 'Finca Marinilla · Antioquia', 4.9, 156, 'bestseller', 50, 20, 
'https://images.unsplash.com/photo-1622206141540-5844544d3f17?auto=format&fit=crop&w=900&h=1125&q=80', 
'https://images.unsplash.com/photo-1556801712-76c82207069a?auto=format&fit=crop&w=900&h=1125&q=80', 
'Una lechuga batavia redonda y compacta con hojas crujientes'),

-- Repollo Morado
('p-20121', 'repollo-morado', 'Repollo Morado', 'Color vibrante y textura crujiente', 'verduras', 'verduras', 5200, 3800, 5900, 'kg', 'Finca Marinilla · Antioquia', 4.6, 28, 'temporada', 12, 8, 
'https://images.unsplash.com/photo-1563227812-0ea4c22e6cc8?auto=format&fit=crop&w=900&h=1125&q=80', 
'https://images.unsplash.com/photo-1590779033100-9f60705a2f3d?auto=format&fit=crop&w=900&h=1125&q=80', 
'Un repollo morado partido a la mitad mostrando su patrón interno laberíntico');