# Alphanumeric only: the password is embedded unencoded in DATABASE_URL,
# where characters like # ? % : / would break URL parsing.
resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "rds" {
  name        = "${var.app_name}-${var.environment}-rds-subnet-group"
  description = "Subnet group for RDS PostgreSQL in private subnets"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${var.app_name}-${var.environment}-rds-subnet-group"
  }
}

resource "aws_db_instance" "postgres" {
  identifier                  = "${var.app_name}-${var.environment}-db"
  engine                      = "postgres"
  engine_version              = var.postgres_version
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = var.db_name
  username                    = var.db_username
  password                    = random_password.db_password.result
  db_subnet_group_name        = aws_db_subnet_group.rds.name
  vpc_security_group_ids      = [aws_security_group.rds.id]
  publicly_accessible         = false
  multi_az                    = var.db_multi_az
  deletion_protection         = var.db_deletion_protection
  skip_final_snapshot         = var.db_skip_final_snapshot
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  tags = {
    Name = "${var.app_name}-${var.environment}-db"
  }
}
