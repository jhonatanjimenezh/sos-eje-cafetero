# AWS RDS Restore Drill

Objetivo: demostrar que los backups de producción realmente pueden restaurarse. Configurar backups **no es suficiente** para cerrar el criterio de recuperación de Issue #1.

> Ejecutar primero con datos sintéticos/piloto. Un restore crea recursos facturables.

## 1. Obtener metadatos

```bash
cd infrastructure/aws/platform
SOURCE=$(terraform output -raw rds_instance_identifier)
SUBNET_GROUP=$(terraform output -raw rds_subnet_group_name)
DB_SG=$(terraform output -raw rds_security_group_id)
```

## 2. Elegir snapshot automático reciente

```bash
SNAPSHOT=$(aws rds describe-db-snapshots \
  --db-instance-identifier "$SOURCE" \
  --snapshot-type automated \
  --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[0].DBSnapshotIdentifier' \
  --output text)

echo "$SNAPSHOT"
```

Validar fecha/hora del snapshot antes de continuar.

## 3. Restaurar en una instancia AISLADA

```bash
DRILL_ID="${SOURCE}-drill-$(date -u +%Y%m%d%H%M)"

aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "$DRILL_ID" \
  --db-snapshot-identifier "$SNAPSHOT" \
  --db-instance-class db.t4g.medium \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "$DB_SG" \
  --no-publicly-accessible \
  --no-multi-az

aws rds wait db-instance-available --db-instance-identifier "$DRILL_ID"
```

El security group solo permite PostgreSQL desde el security group del API, de modo que el restore no queda expuesto a Internet.

## 4. Validar DATOS, no solo estado `available`

Desde un cliente temporal autorizado dentro de la VPC (por ejemplo una tarea ECS administrativa controlada por la entidad), ejecutar contra el endpoint restaurado:

```sql
SELECT postgis_version();
SELECT filename, applied_at FROM schema_migrations ORDER BY filename;
SELECT count(*) FROM incidents;
SELECT count(*) FROM agencies;
```

Para un simulacro previamente preparado, validar además IDs/cantidades esperadas y una consulta geoespacial simple.

No conectar la aplicación pública al restore durante el drill.

## 5. Registrar evidencia

En Issue #1 o en el sistema interno de la entidad registrar únicamente información no sensible:

```text
fecha UTC:
snapshot timestamp:
restore disponible: SI/NO
tiempo hasta available:
postgis_version: OK/FAIL
schema_migrations: OK/FAIL
conteos sintéticos esperados: OK/FAIL
operador:
observaciones:
```

No pegar credenciales, endpoints privados ni dumps.

## 6. Eliminar el drill

Después de validar y conservar la evidencia operacional:

```bash
aws rds delete-db-instance \
  --db-instance-identifier "$DRILL_ID" \
  --skip-final-snapshot

aws rds wait db-instance-deleted --db-instance-identifier "$DRILL_ID"
```

## Criterio de aprobación

Issue #1 puede marcar su requisito de restore como cumplido únicamente cuando:
- se restauró un snapshot real del entorno correspondiente;
- se comprobó PostGIS + migrations + datos esperados;
- se midió tiempo de recuperación;
- el recurso temporal fue eliminado;
- el resultado quedó documentado.
