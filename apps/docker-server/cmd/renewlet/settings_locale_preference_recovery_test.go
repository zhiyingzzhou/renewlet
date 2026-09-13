package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestPrepareExclusiveSchemaDataMigrationsCreatesAndReusesRecoveryPoint(t *testing.T) {
	app := newSchemaTestApp(t)
	seedSettingsLocalePreferenceRecoveryHistory(t, app)

	if err := prepareExclusiveSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	if exists, err := inspectSchemaMigrationRecoveryPoint(app, settingsLocalePreferenceRecoveryPoint); err != nil || !exists {
		t.Fatalf("created recovery point exists=%v err=%v", exists, err)
	}

	sentinel := recoveryPointZIP(t, "data.db", append([]byte(sqliteDatabaseHeader), []byte("sentinel")...))
	uploadSettingsLocalePreferenceRecoveryPoint(t, app, sentinel)
	if err := prepareExclusiveSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	if size := settingsLocalePreferenceRecoveryPointSize(t, app); size != int64(len(sentinel)) {
		t.Fatalf("existing recovery point was replaced: size=%d want=%d", size, len(sentinel))
	}
}

func TestPrepareExclusiveSchemaDataMigrationsRejectsInvalidRecoveryPoint(t *testing.T) {
	tests := []struct {
		name    string
		content func(*testing.T) []byte
	}{
		{name: "empty", content: func(*testing.T) []byte { return nil }},
		{name: "invalid zip", content: func(*testing.T) []byte { return []byte("not-a-zip") }},
		{name: "missing data db", content: func(t *testing.T) []byte { return recoveryPointZIP(t, "auxiliary.db", []byte(sqliteDatabaseHeader)) }},
		{name: "aliased data db", content: func(t *testing.T) []byte { return recoveryPointZIP(t, "./data.db", []byte(sqliteDatabaseHeader)) }},
		{name: "symlink data db", content: symlinkRecoveryPointDatabase},
		{name: "invalid sqlite", content: func(t *testing.T) []byte { return recoveryPointZIP(t, "data.db", []byte("not a sqlite database")) }},
		{name: "corrupt data db body", content: corruptRecoveryPointDatabase},
		{name: "duplicate data db", content: duplicateRecoveryPointDatabases},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app := newSchemaTestApp(t)
			seedSettingsLocalePreferenceRecoveryHistory(t, app)
			content := tt.content(t)
			uploadSettingsLocalePreferenceRecoveryPoint(t, app, content)

			err := prepareExclusiveSchemaDataMigrations(app)
			if err == nil || !strings.Contains(err.Error(), "invalid destructive migration recovery point") {
				t.Fatalf("invalid recovery point error = %v", err)
			}
			if size := settingsLocalePreferenceRecoveryPointSize(t, app); size != int64(len(content)) {
				t.Fatalf("invalid recovery point was overwritten: size=%d want=%d", size, len(content))
			}
		})
	}
}

func TestPrepareExclusiveSchemaDataMigrationsFailsClosedWhenBackupStorageCannotOpen(t *testing.T) {
	app := newSchemaTestApp(t)
	seedSettingsLocalePreferenceRecoveryHistory(t, app)
	app.Settings().Backups.S3.Enabled = true

	err := prepareExclusiveSchemaDataMigrations(app)
	if err == nil || !strings.Contains(err.Error(), "open destructive migration backup storage") {
		t.Fatalf("backup storage error = %v", err)
	}
}

func TestPrepareExclusiveSchemaDataMigrationsFailsClosedWhenBackupCreationFails(t *testing.T) {
	app := newSchemaTestApp(t)
	seedSettingsLocalePreferenceRecoveryHistory(t, app)
	app.OnBackupCreate().BindFunc(func(*core.BackupEvent) error {
		return errors.New("backup unavailable")
	})

	err := prepareExclusiveSchemaDataMigrations(app)
	if err == nil || !strings.Contains(err.Error(), "create destructive migration recovery point: backup unavailable") {
		t.Fatalf("backup creation error = %v", err)
	}
}

func seedSettingsLocalePreferenceRecoveryHistory(t *testing.T, app core.App) {
	t.Helper()
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	createSchemaTestUser(t, app, "locale-recovery@example.com")
}

func recoveryPointZIP(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func corruptRecoveryPointDatabase(t *testing.T) []byte {
	t.Helper()
	content := append([]byte(sqliteDatabaseHeader), bytes.Repeat([]byte("database-page"), 32)...)
	archive := recoveryPointZIP(t, "data.db", content)
	offset := bytes.Index(archive, content)
	if offset < 0 {
		t.Fatal("stored data.db content is missing from test ZIP")
	}
	archive[offset+len(content)-1] ^= 0xff
	return archive
}

func duplicateRecoveryPointDatabases(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for range 2 {
		entry, err := writer.CreateHeader(&zip.FileHeader{Name: "data.db", Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(sqliteDatabaseHeader)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func symlinkRecoveryPointDatabase(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: "data.db", Method: zip.Store}
	header.SetMode(os.ModeSymlink | 0o777)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte(sqliteDatabaseHeader)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func uploadSettingsLocalePreferenceRecoveryPoint(t *testing.T, app core.App, content []byte) {
	t.Helper()
	fsys, err := app.NewBackupsFilesystem()
	if err != nil {
		t.Fatal(err)
	}
	if err := fsys.Upload(content, settingsLocalePreferenceRecoveryPoint); err != nil {
		_ = fsys.Close()
		t.Fatal(err)
	}
	if err := fsys.Close(); err != nil {
		t.Fatal(err)
	}
}

func settingsLocalePreferenceRecoveryPointSize(t *testing.T, app core.App) int64 {
	t.Helper()
	fsys, err := app.NewBackupsFilesystem()
	if err != nil {
		t.Fatal(err)
	}
	attributes, err := fsys.Attributes(settingsLocalePreferenceRecoveryPoint)
	if err != nil {
		_ = fsys.Close()
		t.Fatal(err)
	}
	if err := fsys.Close(); err != nil {
		t.Fatal(err)
	}
	return attributes.Size
}
