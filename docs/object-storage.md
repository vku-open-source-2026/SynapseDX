# Object storage (S3-compatible)

SynapseDX speaks the standard S3 API for all objects (workflow backups, artifacts,
uploads...), so the backend can be swapped without changing any calling code.

## Default: S3Mock (local/dev)

- Service `s3` (`adobe/s3mock`, Apache-2.0), internal endpoint `http://s3:9090`,
  outside the machine `http://localhost:9090` (`S3_HOST_PORT`).
- Bucket `synapsedx-core` (`S3_BUCKET`) is auto-created by the `s3-init` service
  (aws-cli + retry loop).
- Try it:
  ```bash
  export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
  aws --endpoint-url http://localhost:9090 s3 ls
  echo hello | aws --endpoint-url http://localhost:9090 s3 cp - s3://synapsedx-core/hello.txt
  ```

## Production: MinIO or AWS S3

- MinIO: replace the `s3` service with `quay.io/minio/minio`
  (`server /data --console-address ":9001"`), `s3-init` with `minio/mc`
  (`mc alias set ... && mc mb -p ...`), keep the service name + `S3_*` env
  (map `S3_ENDPOINT=http://s3:9000`).
- Real AWS S3: drop the `s3`/`s3-init` services, set
  `S3_ENDPOINT=https://s3.<region>.amazonaws.com` + real keys.
- History: the first revision used `minio/minio` on Docker Hub, but that repo was
  removed (pull error `repository does not exist`), so the default moved to S3Mock —
  see `NOTICE`.

## Roadmap

- `v0.2`: `Bucket` API in IAM/workflow (presigned upload/download URLs via `S3_ENDPOINT`), see `ROADMAP.md`.
