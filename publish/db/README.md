# Database

Schema scripts must be run against SQL Server 2019+ in this order:

```powershell
# 1. Create database
sqlcmd -S localhost -Q "CREATE DATABASE AD_Monitoring"

# 2. Apply schema
sqlcmd -S localhost -d AD_Monitoring -i db/schema/01-tables.sql

# 3. Seed roles
sqlcmd -S localhost -d AD_Monitoring -i db/schema/02-seed-roles.sql
```

The install-center.ps1 script automates these steps.
