package com.remotehunt.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;

/** Exposes the saved CV as content://com.remotehunt.app.cv/cv so web upload fields can receive it. */
public class CvProvider extends ContentProvider {
    static final String AUTHORITY = "com.personal.remotehunt.cv"; // must match AndroidManifest.xml
    static final Uri CV_URI = Uri.parse("content://" + AUTHORITY + "/cv");

    @Override public boolean onCreate() { return true; }

    JSONObject meta() {
        try {
            File f = new File(new File(getContext().getFilesDir(), "kv"), "cv.meta.txt");
            byte[] b = MainActivity.readAll(new FileInputStream(f));
            return new JSONObject(new String(b, "UTF-8"));
        } catch (Exception e) {
            return null;
        }
    }

    File file() {
        JSONObject m = meta();
        if (m == null) return null;
        File f = new File(m.optString("path", ""));
        return f.exists() ? f : null;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String sel, String[] args, String sort) {
        File f = file();
        if (f == null) return null;
        JSONObject m = meta();
        MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        c.addRow(new Object[]{m.optString("name", f.getName()), f.length()});
        return c;
    }

    @Override
    public String getType(Uri uri) {
        JSONObject m = meta();
        return m == null ? null : m.optString("mime", "application/octet-stream");
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = file();
        if (f == null) throw new FileNotFoundException("No CV saved");
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Uri insert(Uri uri, ContentValues v) { return null; }
    @Override public int delete(Uri uri, String s, String[] a) { return 0; }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}
