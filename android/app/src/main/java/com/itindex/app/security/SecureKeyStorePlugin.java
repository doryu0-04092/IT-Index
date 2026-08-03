package com.itindex.app.security;

import android.app.Activity;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Android KeystoreにAES-256-GCM鍵を持たせ、端末標準のロック解除（生体認証・PIN・パターン
 * いずれか）でゲートするプラグイン。PC版はWebAuthnのパスキー（PRF拡張）でAPIキーを暗号化
 * するが、Android実機ではパスキー未設定でこの手段が使えないことが多いため、代わりにこちらを
 * 使う（ユーザー指摘）。TypeScript契約は src/native/secureKeyStore.ts を参照。
 *
 * 鍵は生体情報の追加登録があると自動的に無効化される（Android既定の安全側の挙動。
 * setInvalidatedByBiometricEnrollmentは明示的にtrueのままにしている）。その場合
 * decrypt は KeyPermanentlyInvalidatedException を投げるので、呼び出し側には
 * 「保存し直してください」という趣旨のエラーメッセージを返す。
 */
@CapacitorPlugin(name = "SecureKeyStore")
public class SecureKeyStorePlugin extends Plugin {

    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "it-index-api-key-store";
    private static final String TRANSFORMATION = KeyProperties.KEY_ALGORITHM_AES + "/"
        + KeyProperties.BLOCK_MODE_GCM + "/" + KeyProperties.ENCRYPTION_PADDING_NONE;
    private static final int GCM_TAG_BITS = 128;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        BiometricManager manager = BiometricManager.from(getContext());
        int authenticators = allowedAuthenticators();
        int result = manager.canAuthenticate(authenticators);

        JSObject ret = new JSObject();
        if (result == BiometricManager.BIOMETRIC_SUCCESS) {
            ret.put("available", true);
            call.resolve(ret);
            return;
        }

        ret.put("available", false);
        ret.put("reason", describeUnavailableReason(result));
        call.resolve(ret);
    }

    @PluginMethod
    public void encrypt(PluginCall call) {
        String plaintext = call.getString("plaintext");
        if (plaintext == null) {
            call.reject("plaintext is required");
            return;
        }

        try {
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key);

            authenticateAndRun(call, cipher, () -> {
                try {
                    byte[] ciphertextBytes = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
                    byte[] iv = cipher.getIV();
                    JSObject ret = new JSObject();
                    ret.put("ciphertext", Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP));
                    ret.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("暗号化に失敗しました: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            call.reject("鍵の準備に失敗しました: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void decrypt(PluginCall call) {
        String ciphertext = call.getString("ciphertext");
        String ivBase64 = call.getString("iv");
        if (ciphertext == null || ivBase64 == null) {
            call.reject("ciphertext and iv are required");
            return;
        }

        try {
            SecretKey key = getOrCreateKey();
            byte[] iv = Base64.decode(ivBase64, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));

            authenticateAndRun(call, cipher, () -> {
                try {
                    byte[] ciphertextBytes = Base64.decode(ciphertext, Base64.NO_WRAP);
                    byte[] plaintextBytes = cipher.doFinal(ciphertextBytes);
                    JSObject ret = new JSObject();
                    ret.put("plaintext", new String(plaintextBytes, StandardCharsets.UTF_8));
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("復号に失敗しました: " + e.getMessage(), e);
                }
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            call.reject("生体情報の登録変更により保存内容を復号できません。もう一度APIキーを保存し直してください。", e);
        } catch (Exception e) {
            call.reject("鍵の準備に失敗しました: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) {
                keyStore.deleteEntry(KEY_ALIAS);
            }
        } catch (Exception ignored) {
            // 鍵が無い・削除に失敗しても、呼び出し側にとっては「保存されていない」状態にできれば十分
        }
        call.resolve();
    }

    private int allowedAuthenticators() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        }
        // API29以前はBIOMETRIC_STRONGとDEVICE_CREDENTIALの組み合わせ判定に対応していないため、
        // BiometricPrompt側は setDeviceCredentialAllowed(true) でPIN等も許可しつつ、
        // ここでの可用性チェックは生体認証の有無だけを見る。
        return BiometricManager.Authenticators.BIOMETRIC_WEAK;
    }

    private String describeUnavailableReason(int result) {
        switch (result) {
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                return "この端末は生体認証・画面ロックに対応していません。";
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "生体認証機能が一時的に利用できません。";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "画面ロック（指紋・顔・PIN・パターンいずれか）が設定されていません。端末の設定から登録してください。";
            case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                return "セキュリティ更新が必要なため、この機能は使えません。";
            default:
                return "この端末では利用できません。";
        }
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);

        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }

        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL
            );
        } else {
            // API29以前はAUTH_DEVICE_CREDENTIALとの組み合わせを鍵側で表現できないため、
            // 生体認証のみを都度要求する（-1 = 操作ごとに認証が必要）。
            builder.setUserAuthenticationValidityDurationSeconds(-1);
        }

        keyGenerator.init(builder.build());
        return keyGenerator.generateKey();
    }

    /** BiometricPromptはメインスレッドから生成・呼び出す必要がある */
    private void authenticateAndRun(PluginCall call, Cipher cipher, Runnable onSuccess) {
        Activity activityRaw = getActivity();
        if (!(activityRaw instanceof FragmentActivity)) {
            call.reject("この端末では認証画面を表示できません。");
            return;
        }
        FragmentActivity activity = (FragmentActivity) activityRaw;

        activity.runOnUiThread(() -> {
            Executor executor = ContextCompat.getMainExecutor(activity);
            BiometricPrompt prompt = new BiometricPrompt(activity, executor, new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    onSuccess.run();
                }

                @Override
                public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                    call.reject("認証をキャンセルまたは失敗しました: " + errString);
                }

                @Override
                public void onAuthenticationFailed() {
                    // 生体情報が一致しなかっただけ。ダイアログはユーザーの再試行を待つため、
                    // ここでは reject しない（最終的に onAuthenticationError か
                    // onAuthenticationSucceeded のどちらかで確定する）。
                }
            });

            BiometricPrompt.PromptInfo.Builder infoBuilder = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("IT-Index")
                .setSubtitle("APIキーへアクセスするには認証が必要です");

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                infoBuilder.setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
                );
            } else {
                //noinspection deprecation
                infoBuilder.setDeviceCredentialAllowed(true);
            }

            prompt.authenticate(infoBuilder.build(), new BiometricPrompt.CryptoObject(cipher));
        });
    }
}
