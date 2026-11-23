package com.nexadesk.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.provider.Settings;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * In-app update of the APK: downloads the new APK into the app's private cache (no file is left in Downloads), checks its SHA-256 against the
 * signed manifest, hands it to Android's PackageInstaller and deletes it. Android still shows its own "Update" confirmation, except where the
 * system allows a silent update (Android 12+ for an app that was installed by this installer).
 */
@CapacitorPlugin(name = "NexaInstaller")
public class NexaInstallerPlugin extends Plugin {
  private static final String ACTION = "com.nexadesk.app.INSTALL_RESULT";
  private static final String STORE = "nexadesk_secure";
  private static final String KEY_ALIAS = "nexadesk_secure_store_v1";
  private static volatile NexaInstallerPlugin activePlugin;
  private volatile boolean busy = false;

  @Override
  public void load() {
    super.load();
    activePlugin = this;
  }

  static void onInstallResult(Intent intent) {
    NexaInstallerPlugin plugin = activePlugin;
    if (plugin == null) return;
    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
    plugin.busy = false;
    JSObject r = new JSObject();
    r.put("status", status);
    String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
    r.put("message", msg == null ? "" : msg);
    r.put("success", status == PackageInstaller.STATUS_SUCCESS);
    plugin.notifyListeners("result", r);
  }

  private boolean allowed() {
    return Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
  }

  private SecretKey secureKey() throws Exception {
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    if (ks.containsAlias(KEY_ALIAS)) return (SecretKey) ks.getKey(KEY_ALIAS, null);
    KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
      .build());
    return gen.generateKey();
  }

  private String readSecure(String name) throws Exception {
    SharedPreferences prefs = getContext().getSharedPreferences(STORE, Context.MODE_PRIVATE);
    String encoded = prefs.getString("v_" + name, "");
    if (encoded.isEmpty()) return "";
    byte[] all = Base64.decode(encoded, Base64.NO_WRAP);
    byte[] iv = java.util.Arrays.copyOfRange(all, 0, 12);
    byte[] ciphertext = java.util.Arrays.copyOfRange(all, 12, all.length);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, secureKey(), new GCMParameterSpec(128, iv));
    return new String(cipher.doFinal(ciphertext), java.nio.charset.StandardCharsets.UTF_8);
  }

  private void writeSecure(String name, String value) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, secureKey());
    byte[] iv = cipher.getIV();
    byte[] ciphertext = cipher.doFinal(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    byte[] all = new byte[iv.length + ciphertext.length];
    System.arraycopy(iv, 0, all, 0, iv.length);
    System.arraycopy(ciphertext, 0, all, iv.length, ciphertext.length);
    boolean saved = getContext().getSharedPreferences(STORE, Context.MODE_PRIVATE).edit()
      .putString("v_" + name, Base64.encodeToString(all, Base64.NO_WRAP)).commit();
    if (!saved) throw new Exception("secure storage write failed");
  }

  private boolean validSecureName(String name) {
    return "deviceKey".equals(name) || "permanentPassword".equals(name) || "trustedPeers".equals(name);
  }

  @PluginMethod
  public void getSecure(PluginCall call) {
    String name = call.getString("key");
    if (name == null) name = "";
    if (!validSecureName(name)) { call.reject("unsupported secure value"); return; }
    try {
      JSObject r = new JSObject();
      r.put("value", readSecure(name));
      call.resolve(r);
    } catch (Exception e) { call.reject("secure storage unavailable", e); }
  }

  @PluginMethod
  public void setSecure(PluginCall call) {
    String name = call.getString("key"), value = call.getString("value");
    if (name == null) name = "";
    if (value == null) value = "";
    int limit = "trustedPeers".equals(name) ? 12000 : 256;
    if (!validSecureName(name) || value.length() > limit) { call.reject("unsupported secure value"); return; }
    try {
      writeSecure(name, value);
      call.resolve();
    } catch (Exception e) { call.reject("secure storage unavailable", e); }
  }

  @PluginMethod
  public void canInstall(PluginCall call) {
    JSObject r = new JSObject();
    r.put("allowed", allowed());
    call.resolve(r);
  }

  @PluginMethod
  public void getAppVersion(PluginCall call) {
    JSObject r = new JSObject();
    try {
      String version = getContext().getPackageManager()
        .getPackageInfo(getContext().getPackageName(), 0).versionName;
      r.put("version", version == null ? "" : version);
    } catch (Exception e) {
      call.reject("could not read installed app version", e);
      return;
    }
    call.resolve(r);
  }

  // opens "Install unknown apps" for NexaDesk (needed once, by Android's rules)
  @PluginMethod
  public void openSettings(PluginCall call) {
    try {
      Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(i);
      call.resolve();
    } catch (Exception e) {
      call.reject("settings");
    }
  }

  private void progress(long got, long total) {
    JSObject r = new JSObject();
    r.put("got", got);
    r.put("total", total);
    notifyListeners("progress", r);
  }

  @PluginMethod
  public void install(final PluginCall call) {
    final String url = call.getString("url");
    final String sha = call.getString("sha256");
    if (url == null || sha == null || !url.startsWith("https://")) { call.reject("bad arguments"); return; }
    if (!allowed()) { call.reject("permission"); return; }
    if (busy) { call.reject("busy"); return; }
    busy = true;
    final Context ctx = getContext();
    new Thread(new Runnable() {
      @Override
      public void run() {
        File f = new File(ctx.getCacheDir(), "nexadesk-update.apk");
        try {
          HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
          con.setConnectTimeout(20000);
          con.setReadTimeout(30000);
          con.setInstanceFollowRedirects(true);
          if (con.getResponseCode() != 200) throw new Exception("download failed (HTTP " + con.getResponseCode() + ")");
          long total = con.getContentLengthLong();
          if (total > 400L * 1024 * 1024) throw new Exception("file too large");
          MessageDigest md = MessageDigest.getInstance("SHA-256");
          long got = 0, lastTick = 0;
          InputStream in = con.getInputStream();
          OutputStream out = new FileOutputStream(f);
          try {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
              out.write(buf, 0, n);
              md.update(buf, 0, n);
              got += n;
              if (got > 400L * 1024 * 1024) throw new Exception("file too large");
              long now = System.currentTimeMillis();
              if (now - lastTick > 300) { lastTick = now; progress(got, total); }
            }
          } finally {
            out.close();
            in.close();
          }
          progress(got, total);
          StringBuilder hex = new StringBuilder();
          for (byte b : md.digest()) hex.append(String.format("%02x", b));
          if (!hex.toString().equalsIgnoreCase(sha.trim())) throw new Exception("checksum mismatch - the file was not installed");

          PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
          PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
          if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
          int id = pi.createSession(params);
          PackageInstaller.Session session = pi.openSession(id);
          try {
            InputStream fin = new FileInputStream(f);
            OutputStream sout = session.openWrite("nexadesk", 0, f.length());
            try {
              byte[] buf = new byte[65536];
              int n;
              while ((n = fin.read(buf)) > 0) sout.write(buf, 0, n);
              session.fsync(sout);
            } finally {
              sout.close();
              fin.close();
            }
            Intent cb = new Intent(ACTION);
            cb.setClass(ctx, NexaInstallResultReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent pend = PendingIntent.getBroadcast(ctx, id, cb, flags);
            session.commit(pend.getIntentSender());
          } finally {
            session.close();
          }
          call.resolve();
        } catch (Exception e) {
          busy = false;
          call.reject(e.getMessage() == null ? "install failed" : e.getMessage());
        } finally {
          //noinspection ResultOfMethodCallIgnored
          f.delete();
        }
      }
    }).start();
  }
}
