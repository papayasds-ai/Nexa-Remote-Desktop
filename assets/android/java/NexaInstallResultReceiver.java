package com.nexadesk.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/** Relaunch NexaDesk after Android finishes installing its in-app APK update. */
public class NexaInstallResultReceiver extends BroadcastReceiver {
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
        context.startActivity(confirmation);
      }
      return;
    }
    if (status != PackageInstaller.STATUS_SUCCESS) return;

    Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    if (launch == null) return;
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    context.startActivity(launch);
  }
}
