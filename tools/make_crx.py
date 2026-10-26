# -*- coding: utf-8 -*-
"""把 extension/ 打包成可安装的 CRX3（Chrome 扩展格式）。

CRX3 结构：
  "Cr24" + uint32(3) + uint32(header_len) + CrxFileHeader(protobuf) + zip
  CrxFileHeader:
    field 2  (repeated AsymmetricKeyProof) = { field1: public_key, field2: signature }
    field 10000 (bytes) = signed_header_data
  signed_header_data = protobuf { field1: crx_id }   # crx_id = sha256(public_key)[:16]
  签名内容 = b"CRX3 SignedData\\x00" + uint32le(len(shd)) + shd + zip
  算法 = RSA-PSS(SHA256, salt=32)

私钥保存在 tools/extension_key.pem，固定不变才能保证扩展 ID 不变（升级要用同一个 ID）。
"""
import hashlib
import io
import os
import struct
import sys
import zipfile

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT_DIR = os.path.join(ROOT, "extension")
KEY_PATH = os.path.join(ROOT, "tools", "extension_key.pem")
OUT_DIRS = [ROOT, os.path.join(r"C:\Users\64381\WorkBuddy\2026-10-26-19-01-38", "king-of-focus")]

SIGNATURE_CONTEXT = b"CRX3 SignedData\x00"


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def field_bytes(num: int, data: bytes) -> bytes:
    return varint((num << 3) | 2) + varint(len(data)) + data


def field_msg(num: int, data: bytes) -> bytes:
    return field_bytes(num, data)


def load_key():
    if os.path.exists(KEY_PATH):
        with open(KEY_PATH, "rb") as f:
            return serialization.load_pem_private_key(f.read(), password=None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with open(KEY_PATH, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
    print("已生成新的扩展私钥:", KEY_PATH)
    return key


def build_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(EXT_DIR):
            for name in files:
                full = os.path.join(base, name)
                rel = os.path.relpath(full, EXT_DIR).replace("\\", "/")
                if rel.startswith("tools/") or rel.endswith(".crx") or rel.endswith(".pem"):
                    continue
                z.write(full, rel)
    return buf.getvalue()


def main():
    if not os.path.exists(os.path.join(EXT_DIR, "manifest.json")):
        sys.exit("找不到 extension/manifest.json")

    key = load_key()
    pub_der = key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    crx_id = hashlib.sha256(pub_der).digest()[:16]
    ext_id = "".join(chr(ord("a") + b) for b in
                     [crx_id[i] >> 4 for i in range(16)] + [crx_id[i] & 0xF for i in range(16)])

    payload = build_zip()
    shd = field_bytes(1, crx_id)

    signed = SIGNATURE_CONTEXT + struct.pack("<I", len(shd)) + shd + payload
    signature = key.sign(
        signed,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32),
        hashes.SHA256(),
    )

    proof = field_bytes(1, pub_der) + field_bytes(2, signature)
    header = field_msg(2, proof) + field_bytes(10000, shd)

    crx = b"Cr24" + struct.pack("<II", 3, len(header)) + header + payload

    # 自检：用公钥把签名验一遍，签不出来就不用交付了
    key.public_key().verify(
        signature,
        signed,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32),
        hashes.SHA256(),
    )
    print("签名自检: 通过")

    targets = []
    for d in OUT_DIRS:
        if os.path.isdir(d):
            targets.append(os.path.join(d, "KingOfFocus-Extension.crx"))
    targets.append(os.path.join(EXT_DIR, "..", "KingOfFocus-Extension.crx"))
    for t in set(targets):
        t = os.path.abspath(t)
        with open(t, "wb") as f:
            f.write(crx)
        print(f"  -> {t}  ({len(crx)} 字节)")

    print("扩展 ID:", ext_id)
    print("公钥指纹(sha256):", hashlib.sha256(pub_der).hexdigest()[:32])
    print("包内文件数:", len(zipfile.ZipFile(io.BytesIO(payload)).namelist()))


if __name__ == "__main__":
    main()
