"""
AWS S3 Helper for Model Uploads
Simplified wrapper around boto3 for S3 operations
"""

import boto3
import os
from typing import Optional, List
from pathlib import Path

class S3Helper:
    def __init__(self, bucket_name: Optional[str] = None, region: str = "us-east-1"):
        """Initialize S3 helper"""
        self.bucket_name = bucket_name or os.getenv("AWS_S3_BUCKET")
        self.region = region or os.getenv("AWS_S3_REGION", "us-east-1")
        self.s3_client = boto3.client("s3", region_name=self.region)
        self.s3_resource = boto3.resource("s3", region_name=self.region)
        
        if not self.bucket_name:
            raise ValueError("Bucket name not provided and AWS_S3_BUCKET not set")
    
    def upload_file(self, local_path: str, s3_key: str) -> str:
        """
        Upload file to S3
        
        Args:
            local_path: Path to local file
            s3_key: S3 object key (path in bucket)
        
        Returns:
            S3 URL
        """
        try:
            self.s3_client.upload_file(local_path, self.bucket_name, s3_key)
            url = f"s3://{self.bucket_name}/{s3_key}"
            print(f"✅ Uploaded: {url}")
            return url
        except Exception as e:
            raise Exception(f"Upload failed: {str(e)}")
    
    def download_file(self, s3_key: str, local_path: str) -> str:
        """
        Download file from S3
        
        Args:
            s3_key: S3 object key
            local_path: Where to save locally
        
        Returns:
            Local path
        """
        try:
            self.s3_client.download_file(self.bucket_name, s3_key, local_path)
            print(f"✅ Downloaded: {local_path}")
            return local_path
        except Exception as e:
            raise Exception(f"Download failed: {str(e)}")
    
    def list_files(self, prefix: str = "") -> List[str]:
        """
        List all files in bucket (optionally filtered by prefix)
        
        Args:
            prefix: Optional prefix to filter
        
        Returns:
            List of object keys
        """
        try:
            response = self.s3_client.list_objects_v2(
                Bucket=self.bucket_name,
                Prefix=prefix
            )
            
            if "Contents" not in response:
                return []
            
            return [obj["Key"] for obj in response["Contents"]]
        except Exception as e:
            raise Exception(f"List failed: {str(e)}")
    
    def delete_file(self, s3_key: str) -> bool:
        """
        Delete file from S3
        
        Args:
            s3_key: S3 object key to delete
        
        Returns:
            True if successful
        """
        try:
            self.s3_client.delete_object(Bucket=self.bucket_name, Key=s3_key)
            print(f"✅ Deleted: {s3_key}")
            return True
        except Exception as e:
            raise Exception(f"Delete failed: {str(e)}")
    
    def get_file_size(self, s3_key: str) -> int:
        """Get file size in bytes"""
        try:
            response = self.s3_client.head_object(Bucket=self.bucket_name, Key=s3_key)
            return response["ContentLength"]
        except Exception as e:
            raise Exception(f"Size check failed: {str(e)}")
    
    def get_presigned_url(self, s3_key: str, expiration_secs: int = 3600) -> str:
        """
        Generate presigned URL (temporary public access)
        
        Args:
            s3_key: S3 object key
            expiration_secs: How long URL is valid (default 1 hour)
        
        Returns:
            Presigned URL
        """
        try:
            url = self.s3_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket_name, "Key": s3_key},
                ExpiresIn=expiration_secs
            )
            return url
        except Exception as e:
            raise Exception(f"Presigned URL generation failed: {str(e)}")
    
    def bucket_info(self) -> dict:
        """Get bucket information"""
        try:
            response = self.s3_client.head_bucket(Bucket=self.bucket_name)
            return {
                "bucket": self.bucket_name,
                "region": self.region,
                "exists": True
            }
        except Exception as e:
            return {"exists": False, "error": str(e)}

# Example usage in your FastAPI app
if __name__ == "__main__":
    # Initialize
    s3 = S3Helper()
    
    # List buckets
    print("📦 S3 Bucket Info:")
    print(s3.bucket_info())
    
    # Upload test
    print("\n📤 Uploading test file...")
    with open("/tmp/test.txt", "w") as f:
        f.write("Test content")
    
    s3.upload_file("/tmp/test.txt", "test-models/test.txt")
    
    # List files
    print("\n📋 Files in bucket:")
    files = s3.list_files()
    for f in files:
        print(f"  - {f}")
    
    # Get presigned URL
    print("\n🔗 Presigned URL:")
    url = s3.get_presigned_url("test-models/test.txt")
    print(f"  {url}")
