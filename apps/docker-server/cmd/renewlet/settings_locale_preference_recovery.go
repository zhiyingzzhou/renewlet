package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/pocketbase/pocketbase/core"
)

const sqliteDatabaseHeader = "SQLite format 3\x00"

// 排他迁移的恢复点必须早于 collection 收敛和数据 backfill；否则备份可能已经包含一半新 schema。
func prepareExclusiveSchemaDataMigrations(app core.App) error {
	for _, migration := range []struct {
		name          string
		recoveryPoint string
		hasHistory    func(core.App) (bool, error)
	}{
		{settingsLocalePreferenceMigrationName, settingsLocalePreferenceRecoveryPoint, historicalRenewletDataExists},
		{notificationMessageMigration, notificationMessageRecoveryPoint, notificationMessageHistoryExists},
	} {
		pending, err := schemaDataMigrationPendingWithoutWrites(app, migration.name)
		if err != nil {
			return err
		}
		if !pending {
			continue
		}
		hasHistory, err := migration.hasHistory(app)
		if err != nil {
			return err
		}
		if !hasHistory {
			continue
		}
		exists, err := inspectSchemaMigrationRecoveryPoint(app, migration.recoveryPoint)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if err := app.CreateBackup(context.Background(), migration.recoveryPoint); err != nil {
			return fmt.Errorf("create destructive migration recovery point: %w", err)
		}
		exists, err = inspectSchemaMigrationRecoveryPoint(app, migration.recoveryPoint)
		if err != nil {
			return err
		}
		if !exists {
			return errors.New("destructive migration recovery point is missing after backup creation")
		}
	}
	return nil
}

func inspectSchemaMigrationRecoveryPoint(app core.App, recoveryPoint string) (exists bool, resultErr error) {
	fsys, err := app.NewBackupsFilesystem()
	if err != nil {
		return false, fmt.Errorf("open destructive migration backup storage: %w", err)
	}
	defer func() {
		if err := fsys.Close(); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("close destructive migration backup storage: %w", err))
		}
	}()

	exists, err = fsys.Exists(recoveryPoint)
	if err != nil {
		return false, fmt.Errorf("check destructive migration recovery point: %w", err)
	}
	if !exists {
		return false, nil
	}
	reader, err := fsys.GetReader(recoveryPoint)
	if err != nil {
		return true, fmt.Errorf("open destructive migration recovery point: %w", err)
	}
	defer func() {
		if err := reader.Close(); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("close destructive migration recovery point: %w", err))
		}
	}()
	if err := validateSchemaMigrationRecoveryPoint(&lockedReaderAt{reader: reader}, reader.Size()); err != nil {
		return true, fmt.Errorf("invalid destructive migration recovery point: %w", err)
	}
	return true, nil
}

func validateSchemaMigrationRecoveryPoint(reader io.ReaderAt, size int64) error {
	if size <= 0 {
		return errors.New("backup is empty")
	}
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		return fmt.Errorf("read backup ZIP directory: %w", err)
	}
	var databaseFile *zip.File
	for _, file := range archive.File {
		if !file.Mode().IsRegular() || file.Name != "data.db" {
			continue
		}
		if databaseFile != nil {
			return errors.New("backup contains multiple data.db entries")
		}
		databaseFile = file
	}
	if databaseFile == nil {
		return errors.New("backup does not contain data.db")
	}
	if databaseFile.UncompressedSize64 < uint64(len(sqliteDatabaseHeader)) {
		return errors.New("data.db is empty or truncated")
	}
	entry, err := databaseFile.Open()
	if err != nil {
		return fmt.Errorf("open data.db from backup: %w", err)
	}
	header := make([]byte, len(sqliteDatabaseHeader))
	_, readErr := io.ReadFull(entry, header)
	if readErr == nil && !bytes.Equal(header, []byte(sqliteDatabaseHeader)) {
		readErr = errors.New("data.db does not contain a SQLite database")
	}
	// 必须读到 entry 末尾才能触发 archive/zip 的 CRC 校验；只验 SQLite 头会复用不可恢复的截断备份。
	if readErr == nil {
		_, readErr = io.Copy(io.Discard, entry)
	}
	closeErr := entry.Close()
	if readErr == nil && closeErr == nil {
		return nil
	}
	var entryErrors []error
	if readErr != nil {
		entryErrors = append(entryErrors, fmt.Errorf("validate data.db from backup: %w", readErr))
	}
	if closeErr != nil {
		entryErrors = append(entryErrors, fmt.Errorf("close data.db from backup: %w", closeErr))
	}
	return errors.Join(entryErrors...)
}

// PocketBase 的本地和 S3 blob reader 只有 ReadSeeker；ZIP 目录读取需要可并发安全的随机访问适配。
type lockedReaderAt struct {
	mu     sync.Mutex
	reader io.ReadSeeker
}

func (r *lockedReaderAt) ReadAt(buffer []byte, offset int64) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, err := r.reader.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}
	read, err := io.ReadFull(r.reader, buffer)
	if errors.Is(err, io.ErrUnexpectedEOF) {
		err = io.EOF
	}
	return read, err
}
