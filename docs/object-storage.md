# Object storage (S3-compatible)

OLP dùng API S3 chuẩn cho mọi object (backup workflow, artifact, upload...), nên backend đổi được mà không đổi code gọi.

## Mặc định: S3Mock (local/dev)
- Service `s3` (`adobe/s3mock`, Apache-2.0), endpoint nội bộ `http://s3:9090`, ngoài máy `http://localhost:9090` (`S3_HOST_PORT`).
- Bucket `olp-core` (`S3_BUCKET`) tự tạo bởi service `s3-init` (aws-cli + retry loop).
- Dùng thử:
  ```bash
  export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
  aws --endpoint-url http://localhost:9090 s3 ls
  echo hello | aws --endpoint-url http://localhost:9090 s3 cp - s3://olp-core/hello.txt
  ```

## Production: MinIO hoặc AWS S3
- MinIO: thay service `s3` bằng `quay.io/minio/minio` (`server /data --console-address ":9001"`),
  `s3-init` bằng `minio/mc` (`mc alias set ... && mc mb -p ...`), giữ nguyên tên service + env `S3_*`
  (map `S3_ENDPOINT=http://s3:9000`).
- AWS S3 thật: bỏ service `s3`/`s3-init`, set `S3_ENDPOINT=https://s3.<region>.amazonaws.com` + key thật.
- Lịch sử: bản đầu dùng `minio/minio` trên Docker Hub, nhưng repo đó đã bị gỡ (pull lỗi
  `repository does not exist`) nên mặc định chuyển sang S3Mock — xem `NOTICE`.

## Roadmap
- `v0.2`: API `Bucket` trong IAM/workflow (presigned URL upload/download qua `S3_ENDPOINT`), xem `ROADMAP.md`.
