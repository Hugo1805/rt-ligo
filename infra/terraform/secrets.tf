resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.app_name}-${var.environment}-database-url"
  description             = "PostgreSQL database connection URL for ${var.app_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.app_name}-${var.environment}-database-url"
  }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${var.db_username}:${random_password.db_password.result}@${aws_db_instance.postgres.endpoint}/${var.db_name}?sslmode=require"
}

resource "aws_secretsmanager_secret" "webhook_secret" {
  name                    = "${var.app_name}-${var.environment}-webhook-secret"
  description             = "HMAC secret for validating webhook signatures (value populated out-of-band)"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.app_name}-${var.environment}-webhook-secret"
  }
}
