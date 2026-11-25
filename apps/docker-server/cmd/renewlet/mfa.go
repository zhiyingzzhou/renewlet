package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const (
	mfaMethodTOTP         = "totp"
	mfaMethodRecoveryCode = "recovery_code"

	mfaSetupMethodTOTP       = "totp_setup"
	mfaRecoveryCodeCount     = 10
	mfaRecoveryCodeBytes     = 9
	mfaAuthTicketMaxAttempts = 5
	mfaTOTPPeriodSeconds     = 30
	mfaTOTPAllowedSkew       = 1
)

// 本文件只处理身份验证器 MFA：TOTP seed、恢复码、MFA ticket 和相关 session 续签。
// 通行密钥属于独立登录凭据，reset/删除不能从这里级联清理。
func mfaStatusForUser(app core.App, userID string) (mfaStatusResponse, error) {
	methods, err := authenticatorMfaMethodsForUser(app, userID)
	if err != nil {
		return mfaStatusResponse{}, err
	}
	recoveryCount, err := unusedRecoveryCodeCount(app, userID)
	if err != nil {
		return mfaStatusResponse{}, err
	}
	passkeyCount, err := passkeyCredentialCount(app, userID)
	if err != nil {
		return mfaStatusResponse{}, err
	}
	return mfaStatusResponse{
		Enabled:                len(methods) > 0,
		Methods:                methods,
		RecoveryCodesRemaining: recoveryCount,
		PasskeyCount:           passkeyCount,
	}, nil
}

func authenticatorMfaMethodsForUser(app core.App, userID string) ([]string, error) {
	methods := []string{}
	totpEnabled, err := userHasTotp(app, userID)
	if err != nil {
		return nil, err
	}
	recoveryCount, err := unusedRecoveryCodeCount(app, userID)
	if err != nil {
		return nil, err
	}
	if totpEnabled {
		methods = append(methods, mfaMethodTOTP)
	}
	if recoveryCount > 0 {
		methods = append(methods, mfaMethodRecoveryCode)
	}
	return methods, nil
}

func userHasTotp(app core.App, userID string) (bool, error) {
	_, err := app.FindFirstRecordByFilter("mfa_totp_credentials", "user = {:user}", dbx.Params{"user": userID})
	if err == nil {
		return true, nil
	}
	if err == sql.ErrNoRows {
		return false, nil
	}
	return false, err
}

func unusedRecoveryCodeCount(app core.App, userID string) (int, error) {
	count, err := app.CountRecords("mfa_recovery_codes", dbx.HashExp{"user": userID, "usedAt": ""})
	return int(count), err
}

func passkeyCredentialCount(app core.App, userID string) (int, error) {
	count, err := app.CountRecords("passkey_credentials", dbx.HashExp{"user": userID})
	return int(count), err
}

func authenticatorMfaEnabledForUser(app core.App, userID string) (bool, []string, error) {
	methods, err := authenticatorMfaMethodsForUser(app, userID)
	return len(methods) > 0, methods, err
}

func productAuthProtectedForUser(app core.App, userID string) (bool, error) {
	methods, err := authenticatorMfaMethodsForUser(app, userID)
	if err != nil {
		return false, err
	}
	passkeyCount, err := passkeyCredentialCount(app, userID)
	if err != nil {
		return false, err
	}
	return len(methods) > 0 || passkeyCount > 0, nil
}

func startTOTPSetup(app core.App, user *core.Record) (mfaTotpSetupResponse, error) {
	// TOTP seed 先进入短期 setup ticket；只有启用接口校验当前密码和验证码后才会成为正式凭据。
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "Renewlet",
		AccountName: user.Email(),
		Period:      mfaTOTPPeriodSeconds,
		SecretSize:  20,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return mfaTotpSetupResponse{}, err
	}
	secret := key.Secret()
	ciphertext, err := encryptMFASecret(app, secret)
	if err != nil {
		return mfaTotpSetupResponse{}, err
	}
	setupID, expiresAt, err := createMfaTicketRecord(app, user.Id, []string{mfaSetupMethodTOTP}, ciphertext)
	if err != nil {
		return mfaTotpSetupResponse{}, err
	}
	return mfaTotpSetupResponse{
		SetupID:    setupID,
		Secret:     secret,
		OtpauthURL: key.URL(),
		ExpiresAt:  expiresAt,
	}, nil
}

func enableTOTP(app core.App, user *core.Record, setupID string, code string) (mfaRecoveryCodesResponse, error) {
	ticket, err := mfaTicketByToken(app, setupID)
	if err != nil {
		return mfaRecoveryCodesResponse{}, err
	}
	if ticket.GetString("user") != user.Id || !recordStringSliceContains(ticket, "methods", mfaSetupMethodTOTP) {
		return mfaRecoveryCodesResponse{}, sql.ErrNoRows
	}
	secret, err := decryptMFASecret(app, ticket.GetString("payloadCiphertext"))
	if err != nil {
		return mfaRecoveryCodesResponse{}, err
	}
	if ok, _, err := validateTOTPCode(secret, code, -1); err != nil {
		return mfaRecoveryCodesResponse{}, err
	} else if !ok {
		return mfaRecoveryCodesResponse{}, sql.ErrNoRows
	}
	var response mfaRecoveryCodesResponse
	err = app.RunInTransaction(func(txApp core.App) error {
		// 启用 TOTP 是账号安全级别切换：同一事务里替换凭据、生成恢复码并续签产品 session。
		collection, err := txApp.FindCollectionByNameOrId("mfa_totp_credentials")
		if err != nil {
			return err
		}
		if existing, err := txApp.FindFirstRecordByFilter("mfa_totp_credentials", "user = {:user}", dbx.Params{"user": user.Id}); err == nil && existing != nil {
			if err := txApp.Delete(existing); err != nil {
				return err
			}
		} else if err != sql.ErrNoRows {
			return err
		}
		credential := core.NewRecord(collection)
		credential.Set("user", user.Id)
		credential.Set("secretCiphertext", ticket.GetString("payloadCiphertext"))
		credential.Set("lastAcceptedStep", 0)
		if err := txApp.Save(credential); err != nil {
			return err
		}
		if txTicket, err := txApp.FindRecordById("mfa_auth_tickets", ticket.Id); err == nil {
			if err := txApp.Delete(txTicket); err != nil {
				return err
			}
		} else if err != sql.ErrNoRows {
			return err
		}
		recoveryCodes, err := replaceRecoveryCodes(txApp, user.Id)
		if err != nil {
			return err
		}
		session, err := renewAccountSecuritySession(txApp, user.Id)
		if err != nil {
			return err
		}
		response = mfaRecoveryCodesResponse{
			Type:          session.Type,
			Session:       session.Session,
			User:          session.User,
			RecoveryCodes: recoveryCodes,
			token:         session.token,
			csrfToken:     session.csrfToken,
		}
		return nil
	})
	if err != nil {
		return mfaRecoveryCodesResponse{}, err
	}
	return response, nil
}

func verifyLoginMFA(app core.App, request mfaVerifyRequest) (sessionResponse, error) {
	ticket, err := mfaTicketByToken(app, request.TicketID)
	if err != nil {
		return sessionResponse{}, err
	}
	if ticket.GetInt("attempts") >= mfaAuthTicketMaxAttempts {
		_ = app.Delete(ticket)
		return sessionResponse{}, sql.ErrNoRows
	}
	if !recordStringSliceContains(ticket, "methods", request.Method) {
		if err := registerFailedMFAAttempt(app, ticket); err != nil {
			return sessionResponse{}, err
		}
		return sessionResponse{}, sql.ErrNoRows
	}
	user, err := app.FindRecordById("users", ticket.GetString("user"))
	if err != nil {
		return sessionResponse{}, err
	}
	if user.GetBool("banned") {
		return sessionResponse{}, sql.ErrNoRows
	}
	var ok bool
	switch request.Method {
	case mfaMethodTOTP:
		ok, err = consumeTOTPCode(app, user.Id, request.Code)
	case mfaMethodRecoveryCode:
		ok, err = consumeRecoveryCode(app, user.Id, request.Code)
	default:
		ok = false
	}
	if err != nil {
		return sessionResponse{}, err
	}
	if !ok {
		if err := registerFailedMFAAttempt(app, ticket); err != nil {
			return sessionResponse{}, err
		}
		return sessionResponse{}, sql.ErrNoRows
	}
	// MFA ticket 成功后必须单次消费；否则同一 password+ticket 可重复换 session。
	if err := app.Delete(ticket); err != nil {
		return sessionResponse{}, err
	}
	return createAppSessionResponse(app, user)
}

func consumeTOTPCode(app core.App, userID string, code string) (bool, error) {
	credential, err := app.FindFirstRecordByFilter("mfa_totp_credentials", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		return false, err
	}
	secret, err := decryptMFASecret(app, credential.GetString("secretCiphertext"))
	if err != nil {
		return false, err
	}
	lastAcceptedStep := credential.GetInt("lastAcceptedStep")
	// NIST 要求 OTP 不能重放；即便允许前后一个时间步，同一 step 成功后也必须被拒绝。
	ok, acceptedStep, err := validateTOTPCode(secret, code, lastAcceptedStep)
	if err != nil || !ok {
		return false, err
	}
	credential.Set("lastAcceptedStep", acceptedStep)
	if err := app.Save(credential); err != nil {
		return false, err
	}
	return true, nil
}

func validateTOTPCode(secret string, code string, lastAcceptedStep int) (bool, int, error) {
	code = strings.TrimSpace(code)
	nowStep := int(time.Now().UTC().Unix() / mfaTOTPPeriodSeconds)
	for offset := -mfaTOTPAllowedSkew; offset <= mfaTOTPAllowedSkew; offset++ {
		step := nowStep + offset
		if step <= lastAcceptedStep {
			continue
		}
		passcode, err := totp.GenerateCodeCustom(secret, time.Unix(int64(step*mfaTOTPPeriodSeconds), 0).UTC(), totp.ValidateOpts{
			Period:    mfaTOTPPeriodSeconds,
			Skew:      0,
			Digits:    otp.DigitsSix,
			Algorithm: otp.AlgorithmSHA1,
		})
		if err != nil {
			return false, 0, err
		}
		if subtle.ConstantTimeCompare([]byte(passcode), []byte(code)) == 1 {
			return true, step, nil
		}
	}
	return false, 0, nil
}

func consumeRecoveryCode(app core.App, userID string, code string) (bool, error) {
	hash, err := recoveryCodeHash(app, code)
	if err != nil {
		return false, err
	}
	record, err := app.FindFirstRecordByFilter(
		"mfa_recovery_codes",
		"user = {:user} && codeHash = {:hash} && usedAt = ''",
		dbx.Params{"user": userID, "hash": hash},
	)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// 恢复码是一次性第二因素；消费后只留 usedAt，不能删除行导致审计和剩余数量不可解释。
	record.Set("usedAt", nowString())
	if err := app.Save(record); err != nil {
		return false, err
	}
	return true, nil
}

func replaceRecoveryCodes(app core.App, userID string) ([]string, error) {
	// 重新生成会让旧的未使用恢复码立即失效；服务端仍只保存 HMAC hash，不保存明文。
	if err := deleteRecordsByFilter(app, "mfa_recovery_codes", "user = {:user}", dbx.Params{"user": userID}); err != nil {
		return nil, err
	}
	collection, err := app.FindCollectionByNameOrId("mfa_recovery_codes")
	if err != nil {
		return nil, err
	}
	codes := make([]string, 0, mfaRecoveryCodeCount)
	for len(codes) < mfaRecoveryCodeCount {
		code, err := newRecoveryCode()
		if err != nil {
			return nil, err
		}
		hash, err := recoveryCodeHash(app, code)
		if err != nil {
			return nil, err
		}
		record := core.NewRecord(collection)
		record.Set("user", userID)
		record.Set("codeHash", hash)
		record.Set("usedAt", "")
		if err := app.Save(record); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, nil
}

func regenerateRecoveryCodesForCurrentUser(app core.App, userID string) (mfaRecoveryCodesResponse, error) {
	var response mfaRecoveryCodesResponse
	err := app.RunInTransaction(func(txApp core.App) error {
		// 恢复码明文只在本次响应出现；续签 cookie session 让旧 session 与旧恢复码在同一状态切换中失效。
		recoveryCodes, err := replaceRecoveryCodes(txApp, userID)
		if err != nil {
			return err
		}
		session, err := renewAccountSecuritySession(txApp, userID)
		if err != nil {
			return err
		}
		response = mfaRecoveryCodesResponse{
			Type:          session.Type,
			Session:       session.Session,
			User:          session.User,
			RecoveryCodes: recoveryCodes,
			token:         session.token,
			csrfToken:     session.csrfToken,
		}
		return nil
	})
	if err != nil {
		return mfaRecoveryCodesResponse{}, err
	}
	return response, nil
}

func disableAuthenticatorMFAForUser(app core.App, userID string) error {
	// 2FA 只覆盖认证器和恢复码；Passkey 是独立安全项，必须走单独 reset，避免管理员误删登录密钥。
	for _, collection := range []string{
		"mfa_totp_credentials",
		"mfa_recovery_codes",
		"mfa_auth_tickets",
	} {
		if err := deleteRecordsByFilter(app, collection, "user = {:user}", dbx.Params{"user": userID}); err != nil {
			return err
		}
	}
	return invalidateUserAuthState(app, userID)
}

func disableAuthenticatorMFAForCurrentUser(app core.App, userID string) (sessionResponse, error) {
	var response sessionResponse
	err := app.RunInTransaction(func(txApp core.App) error {
		// 自助关闭认证器只移除 TOTP/恢复码；通行密钥仍独立保留，当前浏览器通过续签 session 继续登录。
		for _, collection := range []string{
			"mfa_totp_credentials",
			"mfa_recovery_codes",
		} {
			if err := deleteRecordsByFilter(txApp, collection, "user = {:user}", dbx.Params{"user": userID}); err != nil {
				return err
			}
		}
		session, err := renewAccountSecuritySession(txApp, userID)
		if err != nil {
			return err
		}
		response = session
		return nil
	})
	if err != nil {
		return sessionResponse{}, err
	}
	return response, nil
}

func deletePasskeysForUser(app core.App, userID string) error {
	// Passkey reset 只清 WebAuthn 凭据和短期 challenge；认证器/恢复码仍由 2FA reset 管理。
	for _, collection := range []string{
		"passkey_credentials",
		"passkey_challenges",
		"mfa_auth_tickets",
	} {
		if err := deleteRecordsByFilter(app, collection, "user = {:user}", dbx.Params{"user": userID}); err != nil {
			return err
		}
	}
	return invalidateUserAuthState(app, userID)
}

func invalidateUserAuthState(app core.App, userID string) error {
	user, err := app.FindRecordById("users", userID)
	if err != nil {
		return err
	}
	// PB tokenKey 轮换覆盖仍可能存在的原生 JWT；产品 session/ticket 另行 hard delete。
	user.RefreshTokenKey()
	if err := app.Save(user); err != nil {
		return err
	}
	if err := deleteAppSessionsForUser(app, userID); err != nil {
		return err
	}
	return deleteRecordsByFilter(app, "mfa_auth_tickets", "user = {:user}", dbx.Params{"user": userID})
}

func mfaTicketByToken(app core.App, token string) (*core.Record, error) {
	hash, err := mfaTicketHash(app, token)
	if err != nil {
		return nil, err
	}
	return app.FindFirstRecordByFilter(
		"mfa_auth_tickets",
		"ticketHash = {:hash} && expiresAt > {:now}",
		dbx.Params{"hash": hash, "now": nowString()},
	)
}

func createMfaTicketRecord(app core.App, userID string, methods []string, payloadCiphertext string) (string, string, error) {
	collection, err := app.FindCollectionByNameOrId("mfa_auth_tickets")
	if err != nil {
		return "", "", err
	}
	token := randomURLToken(mfaTicketTokenN)
	hash, err := mfaTicketHash(app, token)
	if err != nil {
		return "", "", err
	}
	expiresAt := time.Now().UTC().Add(mfaAuthTicketTTL).Format(time.RFC3339Nano)
	record := core.NewRecord(collection)
	record.Set("user", userID)
	// ticket 是短期二阶段状态，只持久化带安装级账号安全密钥的 HMAC，不能当 session 使用。
	record.Set("ticketHash", hash)
	record.Set("expiresAt", expiresAt)
	record.Set("attempts", 0)
	record.Set("methods", methods)
	record.Set("payloadCiphertext", payloadCiphertext)
	if err := app.Save(record); err != nil {
		return "", "", err
	}
	return token, expiresAt, nil
}

func registerFailedMFAAttempt(app core.App, ticket *core.Record) error {
	attempts := ticket.GetInt("attempts") + 1
	if attempts >= mfaAuthTicketMaxAttempts {
		return app.Delete(ticket)
	}
	ticket.Set("attempts", attempts)
	return app.Save(ticket)
}

func deleteRecordsByFilter(app core.App, collection string, filter string, params dbx.Params) error {
	for {
		records, err := app.FindRecordsByFilter(collection, filter, "created", 200, 0, params)
		if err != nil {
			return err
		}
		if len(records) == 0 {
			return nil
		}
		for _, record := range records {
			if err := app.Delete(record); err != nil {
				return err
			}
		}
	}
}

func recordStringSliceContains(record *core.Record, field string, expected string) bool {
	for _, value := range record.GetStringSlice(field) {
		if value == expected {
			return true
		}
	}
	return false
}

func encryptMFASecret(app core.App, plaintext string) (string, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	return sealSecurityText(ring.totpSeed, plaintext)
}
func sealSecurityText(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	return "v1." + base64.RawURLEncoding.EncodeToString(nonce) + "." + base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

func decryptMFASecret(app core.App, value string) (string, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	return openSecurityText(ring.totpSeed, value)
}
func openSecurityText(key []byte, value string) (string, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return "", errors.New("invalid MFA ciphertext")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(nonce) != gcm.NonceSize() {
		return "", errors.New("invalid nonce")
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func recoveryCodeHash(app core.App, code string) (string, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, ring.recoveryCode)
	mac.Write([]byte("renewlet:mfa:recovery:v1:"))
	mac.Write([]byte(normalizeRecoveryCode(code)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func mfaTicketHash(app core.App, token string) (string, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, ring.mfaTicket)
	mac.Write([]byte("renewlet:mfa:ticket:v1:"))
	mac.Write([]byte(token))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func passkeyChallengeHash(app core.App, token string) (string, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, ring.passkeyChallenge)
	mac.Write([]byte("renewlet:passkey:challenge:v1:"))
	mac.Write([]byte(token))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func newRecoveryCode() (string, error) {
	data := make([]byte, mfaRecoveryCodeBytes)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	encoded := strings.TrimRight(base32.StdEncoding.EncodeToString(data), "=")
	encoded = strings.ToUpper(encoded)
	if len(encoded) < 12 {
		return "", fmt.Errorf("recovery code entropy output too short")
	}
	return encoded[:4] + "-" + encoded[4:8] + "-" + encoded[8:12], nil
}

func normalizeRecoveryCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.ReplaceAll(code, "-", "")
	code = strings.ReplaceAll(code, " ", "")
	return code
}
