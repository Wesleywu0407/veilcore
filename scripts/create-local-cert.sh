#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cert_dir="$repo_root/.cert"
mkdir -p "$cert_dir"

lan_ip=${VEILCORE_IP:-$(ipconfig getifaddr en0 2>/dev/null || true)}
if [ -z "$lan_ip" ]; then lan_ip=127.0.0.1; fi

if [ ! -f "$cert_dir/ca.key" ] || [ ! -f "$cert_dir/veilcore-ca.crt" ]; then
  openssl genrsa -out "$cert_dir/ca.key" 2048
  openssl req -x509 -new -nodes -key "$cert_dir/ca.key" -sha256 -days 825 \
    -subj "/CN=Veilcore Local CA" -out "$cert_dir/veilcore-ca.crt"
fi

config=$(mktemp)
trap 'rm -f "$config" "$cert_dir/server.csr"' EXIT
cat > "$config" <<EOF
[req]
distinguished_name=req_distinguished_name
req_extensions=req_ext
prompt=no
[req_distinguished_name]
CN=veilcore.local
[req_ext]
subjectAltName=@alt_names
[alt_names]
DNS.1=localhost
DNS.2=veilcore.local
IP.1=127.0.0.1
IP.2=$lan_ip
EOF

openssl genrsa -out "$cert_dir/server.key" 2048
openssl req -new -key "$cert_dir/server.key" -out "$cert_dir/server.csr" -config "$config"
openssl x509 -req -in "$cert_dir/server.csr" -CA "$cert_dir/veilcore-ca.crt" -CAkey "$cert_dir/ca.key" \
  -CAcreateserial -out "$cert_dir/server.crt" -days 397 -sha256 -extensions req_ext -extfile "$config"

printf 'Created HTTPS certificate for localhost and %s\n' "$lan_ip"
printf 'Friends must install and trust: %s\n' "$cert_dir/veilcore-ca.crt"
