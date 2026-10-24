package com.code2video.backgroundrender;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.view.View;
import android.webkit.WebView;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Lets a render keep going when the user leaves the app: starts a foreground service
 * (with a progress notification and a CPU wake lock) and stops the WebView from treating
 * the page as hidden, which would otherwise throttle the JavaScript render loop.
 */
@CapacitorPlugin(
    name = "BackgroundRender",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class BackgroundRenderPlugin extends Plugin {

    private boolean active = false;
    private String title = "ভিডিও রেন্ডার হচ্ছে";

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        // Rendering works with or without the notification permission.
        doStart(call);
    }

    private void doStart(PluginCall call) {
        Context ctx = getContext();
        title = call.getString("title", title);
        Intent intent = new Intent(ctx, RenderService.class);
        intent.putExtra(RenderService.EXTRA_TITLE, title);
        intent.putExtra(RenderService.EXTRA_TEXT, call.getString("text", ""));
        try {
            ContextCompat.startForegroundService(ctx, intent);
        } catch (Exception e) {
            call.reject("Could not start background rendering: " + e.getMessage());
            return;
        }
        NotificationManagerCompat.from(ctx).cancel(RenderService.DONE_ID);
        active = true;
        keepWebViewAwake();
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (active) {
            RenderService.notifyProgress(getContext(), title, call.getString("text", ""), call.getInt("progress", -1));
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopService();
        String doneTitle = call.getString("doneTitle");
        if (doneTitle != null) RenderService.notifyDone(getContext(), doneTitle, call.getString("doneText", ""));
        call.resolve();
    }

    private void stopService() {
        active = false;
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, RenderService.class));
    }

    private void keepWebViewAwake() {
        WebView wv = getBridge().getWebView();
        if (wv == null) return;
        Runnable r = () -> {
            if (!active) return;
            // Chromium throttles pages it believes are hidden; keep reporting "visible".
            wv.dispatchWindowVisibilityChanged(View.VISIBLE);
            wv.resumeTimers();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
        };
        wv.post(r);
        wv.postDelayed(r, 300);
        wv.postDelayed(r, 1500);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (active) keepWebViewAwake();
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        if (active) keepWebViewAwake();
    }

    @Override
    protected void handleOnDestroy() {
        if (active) stopService();
        super.handleOnDestroy();
    }
}
