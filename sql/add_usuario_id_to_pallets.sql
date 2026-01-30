-- Migración definitiva: las tablas usan UUID para los IDs de usuario
-- Eliminamos la columna si existe para asegurar el tipo correcto
ALTER TABLE alta_pallets DROP COLUMN IF EXISTS usuario_id CASCADE;

-- Agregamos la columna como UUID
ALTER TABLE alta_pallets ADD COLUMN usuario_id UUID REFERENCES usuarios(id);
