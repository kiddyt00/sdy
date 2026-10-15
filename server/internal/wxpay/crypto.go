// 微信支付 v3 的密码学原语：密钥解析、RSA-SHA256 签名/验签、回调 AES-256-GCM 解密。
// 全部来自 Go 标准库，不引入任何第三方依赖。
package wxpay

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
)

// parsePrivateKey 解析商户私钥 PEM：先按 PKCS#8（BEGIN PRIVATE KEY），再按 PKCS#1（BEGIN RSA PRIVATE KEY）。
// 微信商户平台下载的 apiclient_key.pem 两种格式都出现过，必须都支持。
func parsePrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("不是合法的 PEM（缺少 -----BEGIN ...----- 块）")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		priv, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("PKCS#8 私钥不是 RSA 类型（实际 %T）", key)
		}
		return priv, nil
	}
	if priv, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return priv, nil
	}
	return nil, fmt.Errorf("私钥既不是 PKCS#8（%s）也不是 PKCS#1（%s）格式", "BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY")
}

// parsePlatformPubKey 解析平台证书 PEM：可能是 CERTIFICATE（x509.ParseCertificate 取 .PublicKey），
// 也可能是 PUBLIC KEY（x509.ParsePKIXPublicKey）；假服务给的是后者，线上证书是前者。两种都要支持。
func parsePlatformPubKey(pemBytes []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("不是合法的 PEM（缺少 -----BEGIN ...----- 块）")
	}
	if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
		pub, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("平台证书公钥不是 RSA 类型（实际 %T）", cert.PublicKey)
		}
		return pub, nil
	}
	if pub, err := x509.ParsePKIXPublicKey(block.Bytes); err == nil {
		rsaPub, ok := pub.(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("平台公钥不是 RSA 类型（实际 %T）", pub)
		}
		return rsaPub, nil
	}
	if pub, err := x509.ParsePKCS1PublicKey(block.Bytes); err == nil {
		return pub, nil
	}
	return nil, errors.New("平台证书 PEM 既不是 CERTIFICATE 也不是 PUBLIC KEY")
}

// signSHA256 用 RSA 私钥做 PKCS#1 v1.5 + SHA-256 签名，返回标准 base64。
func signSHA256(priv *rsa.PrivateKey, message string) (string, error) {
	if priv == nil {
		return "", errors.New("私钥为空")
	}
	sum := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

// verifySHA256 用 RSA 公钥验签（签名是标准 base64 文本）。签名格式非法时返回错误而不是 panic。
func verifySHA256(pub *rsa.PublicKey, message, signatureB64 string) error {
	if pub == nil {
		return errors.New("公钥为空")
	}
	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return fmt.Errorf("签名不是合法 base64：%w", err)
	}
	sum := sha256.Sum256([]byte(message))
	return rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig)
}

// newNonce 生成 32 位十六进制随机串（微信要求 nonce_str ≤ 32 位）。
func newNonce() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成随机串失败：%w", err)
	}
	return hex.EncodeToString(buf), nil
}

// aesGCMDecrypt 回调报文解密：AES-256-GCM，key = 32 字节 APIv3 密钥，
// nonce = resource.nonce，AAD = resource.associated_data，密文 base64（尾部 16 字节是 GCM tag）。
func aesGCMDecrypt(apiV3Key, nonce, associatedData, ciphertextB64 string) ([]byte, error) {
	key := []byte(apiV3Key)
	if len(key) != 32 {
		return nil, fmt.Errorf("APIv3 密钥必须恰好 32 字节（当前 %d）", len(key))
	}
	ciphertext, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return nil, fmt.Errorf("密文不是合法 base64：%w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("初始化 AES 失败：%w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("初始化 GCM 失败：%w", err)
	}
	nonceBytes := []byte(nonce)
	if len(nonceBytes) != gcm.NonceSize() {
		return nil, fmt.Errorf("回调 nonce 必须是 %d 字节（当前 %d）", gcm.NonceSize(), len(nonceBytes))
	}
	plain, err := gcm.Open(nil, nonceBytes, ciphertext, []byte(associatedData))
	if err != nil {
		// 不把密钥写进错误，避免日志泄露。
		return nil, fmt.Errorf("AES-256-GCM 解密失败（APIv3 密钥与微信不一致，或报文被篡改）：%w", err)
	}
	return plain, nil
}
