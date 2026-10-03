provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "wallet-cash-in"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
