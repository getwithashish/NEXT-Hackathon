import boto3
import json
from botocore.exceptions import ClientError

region = "us-east-1"
account_id = "736268087112"
role_name = "fingerprint-lambda-role"
ecr_repo_name = "fingerprint-worker"

iam = boto3.client("iam", region_name=region)
ecr = boto3.client("ecr", region_name=region)

# ── 1. IAM Role ──────────────────────────────────────────────────────────────
trust_policy = json.dumps({
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "lambda.amazonaws.com"},
        "Action": "sts:AssumeRole"
    }]
})

try:
    resp = iam.create_role(
        RoleName=role_name,
        AssumeRolePolicyDocument=trust_policy,
        Description="IAM role for Lambda-based model fingerprinting"
    )
    role_arn = resp["Role"]["Arn"]
    print(f"[IAM] Role created: {role_arn}")
except ClientError as e:
    if e.response["Error"]["Code"] == "EntityAlreadyExists":
        role_arn = iam.get_role(RoleName=role_name)["Role"]["Arn"]
        print(f"[IAM] Role already exists: {role_arn}")
    else:
        raise

# Attach managed policies
managed_policies = [
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    "arn:aws:iam::aws:policy/AmazonBedrockFullAccess",
]
for policy_arn in managed_policies:
    try:
        iam.attach_role_policy(RoleName=role_name, PolicyArn=policy_arn)
        print(f"[IAM] Attached policy: {policy_arn}")
    except ClientError as e:
        print(f"[IAM] Policy attach note ({policy_arn}): {e.response['Error']['Code']}")

# Inline policy for lambda:InvokeFunction
inline_policy = json.dumps({
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Action": "lambda:InvokeFunction",
        "Resource": "*"
    }]
})
iam.put_role_policy(
    RoleName=role_name,
    PolicyName="LambdaInvokeInline",
    PolicyDocument=inline_policy
)
print("[IAM] Inline policy 'LambdaInvokeInline' applied.")

# ── 2. ECR Repository ─────────────────────────────────────────────────────────
try:
    resp = ecr.create_repository(
        repositoryName=ecr_repo_name,
        region=region,
        imageScanningConfiguration={"scanOnPush": True},
        imageTagMutability="MUTABLE"
    )
    ecr_uri = resp["repository"]["repositoryUri"]
    print(f"[ECR] Repository created: {ecr_uri}")
except ClientError as e:
    if e.response["Error"]["Code"] == "RepositoryAlreadyExistsException":
        resp = ecr.describe_repositories(repositoryNames=[ecr_repo_name])
        ecr_uri = resp["repositories"][0]["repositoryUri"]
        print(f"[ECR] Repository already exists: {ecr_uri}")
    else:
        raise

# ── 3. Final summary ──────────────────────────────────────────────────────────
print("\n" + "="*60)
print("FINAL RESULTS")
print("="*60)
print(f"IAM Role ARN : {role_arn}")
print(f"ECR Repo URI : {ecr_uri}")
print("="*60)
