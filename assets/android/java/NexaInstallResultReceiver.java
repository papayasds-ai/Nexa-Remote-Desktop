package com.nexadesk.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

/** Notifies the user when Android finishes installing an in-app APK update. */
public class NexaInstallResultReceiver extends BroadcastReceiver {
  private static final String CHANNEL_ID = "nexadesk_app_updates";
  private static final int NOTIFICATION_ID = 12601;

  @Override
  public void onReceive(Context context, Intent intent) {
    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      Intent confirmation;
      if (Build.VERSION.SDK_INT >= 33) confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
      else {
        @SuppressWarnings("deprecation")
        Intent legacy = intent.getParcelableExtra(Intent.EXTRA_INTENT);
        confirmation = legacy;
      }
      if (confirmation != null) {
        confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
          context.startActivity(confirmation);
        } catch (Exception e) {
          Intent failed = new Intent(intent);
          failed.putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
          failed.putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, "Could not open Android install confirmation");
          NexaInstallerPlugin.onInstallResult(failed);
        }
      } else {
        Intent failed = new Intent(intent);
        failed.putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        failed.putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, "Android did not provide an install confirmation");
        NexaInstallerPlugin.onInstallResult(failed);
      }
      return;
    }
    NexaInstallerPlugin.onInstallResult(intent);
    if (status != PackageInstaller.STATUS_SUCCESS) return;

    showUpdateNotification(context);
  }

  private void showUpdateNotification(Context context) {
    try {
      if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
      NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
      if (manager == null) return;
      if (Build.VERSION.SDK_INT >= 26) {
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "App updates", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Lets you reopen NexaDesk after an app update");
        manager.createNotificationChannel(channel);
      }

      Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
      if (launch == null) return;
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
      int flags = PendingIntent.FLAG_UPDATE_CURRENT;
      if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
      PendingIntent openApp = PendingIntent.getActivity(context, NOTIFICATION_ID, launch, flags);
      String version = "";
      try {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        if (info.versionName != null) version = " v" + info.versionName;
      } catch (Exception ignored) { }

      Notification.Builder builder = Build.VERSION.SDK_INT >= 26
        ? new Notification.Builder(context, CHANNEL_ID)
        : new Notification.Builder(context);
      Notification notification = builder
        .setSmallIcon(context.getApplicationInfo().icon)
        .setContentTitle("NexaDesk updated" + version)
        .setContentText("Tap to open the updated app")
        .setContentIntent(openApp)
        .setAutoCancel(true)
        .setCategory(Notification.CATEGORY_STATUS)
        .build();
      manager.notify(NOTIFICATION_ID, notification);
    } catch (Exception ignored) {
      // Android may disable notifications or reject a launch request; do not crash the install callback.
    }
  }
}
