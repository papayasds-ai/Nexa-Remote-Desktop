package com.nexadesk.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
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

/**
 * In-app update of the APK: downloads the new APK into the app's private cache (no file is left in Downloads), checks its SHA-256 against the
 * signed manifest, hands it to Android's PackageInstaller and deletes it. Android still shows its own "Update" confirmation, except where the
 * system allows a silent update (Android 12+ for an app that was installed by this installer).
 */
@CapacitorPlugin(name = "NexaInstaller")
public class NexaInstallerPlugin extends Plugin {
  private static final String ACTION = "com.nexadesk.app.INSTALL_RESULT";
  private BroadcastReceiver receiver;
  private volatile boolean busy = false;

  private boolean allowed() {
    return Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
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

  private void ensureReceiver() {
    if (receiver != null) return;
    receiver = new BroadcastReceiver() {
      @Override
      @SuppressWarnings("deprecation")
      public void onReceive(Context c, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
          Intent confirm = (Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT);
          if (confirm != null) {
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { c.startActivity(confirm); } catch (Exception ignored) { }
          }
          return;
        }
        busy = false;
        JSObject r = new JSObject();
        r.put("status", status);
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        r.put("message", msg == null ? "" : msg);
        r.put("success", status == PackageInstaller.STATUS_SUCCESS);
        notifyListeners("result", r);
      }
    };
    ContextCompat.registerReceiver(getContext(), receiver, new IntentFilter(ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
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
    ensureReceiver();
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
