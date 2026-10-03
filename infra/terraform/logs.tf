resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.app_name}-${var.environment}"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "/ecs/${var.app_name}-${var.environment}"
  }
}
