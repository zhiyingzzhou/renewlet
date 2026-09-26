package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
)

func TestSettingsLocalePreferenceGuardAllowListMatchesSupportedLocales(t *testing.T) {
	expected := []string{"'" + string(autoLocalePreference) + "'"}
	for _, locale := range supportedAppLocales {
		expected = append(expected, "'"+string(locale)+"'")
	}
	if got, want := settingsLocalePreferenceGuardAllowList, strings.Join(expected, ", "); got != want {
		t.Fatalf("guard allow-list = %s, want %s; add a new guard migration when supported locales change", got, want)
	}
}

func TestSettingsLocalePreferenceGuardV2UpgradesLegacyTrigger(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	for name, statement := range settingsLocalePreferenceGuardV1SQL {
		if _, err := app.DB().NewQuery("DROP TRIGGER IF EXISTS " + name).Execute(); err != nil {
			t.Fatal(err)
		}
		if _, err := app.DB().NewQuery(statement).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := app.DB().NewQuery("DELETE FROM " + schemaDataMigrationsTable + " WHERE name = {:name}").
		Bind(dbx.Params{"name": settingsLocalePreferenceGuardV2MigrationName}).
		Execute(); err != nil {
		t.Fatal(err)
	}

	insert := func(id string, settings string) error {
		user := createSchemaTestUser(t, app, "locale-guard-v2-"+strings.ReplaceAll(id, "_", "-")+"@example.com")
		_, err := app.DB().NewQuery(`INSERT INTO settings (id, user, settings, created, updated)
			VALUES ({:id}, {:user}, {:settings}, '', '')`).Bind(dbx.Params{
			"id":       id,
			"user":     user.Id,
			"settings": settings,
		}).Execute()
		return err
	}
	if err := insert("legacy_ru", `{"localePreference":"ru-RU"}`); err == nil || !strings.Contains(err.Error(), "SETTINGS_LOCALE_CONTRACT_INVALID") {
		t.Fatalf("v1 guard should reject ru-RU, got %v", err)
	}
	if err := insert("existing_en", `{"localePreference":"en-US","monthlyBudget":"42"}`); err != nil {
		t.Fatal(err)
	}

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatalf("guard v2 upgrade failed: %v", err)
	}
	if err := verifySettingsLocalePreferenceGuard(app); err != nil {
		t.Fatalf("guard v2 not installed: %v", err)
	}

	if err := insert("upgraded_ru", `{"localePreference":"ru-RU"}`); err != nil {
		t.Fatalf("v2 guard should accept ru-RU, got %v", err)
	}
	if err := insert("upgraded_fr", `{"localePreference":"fr-FR"}`); err == nil || !strings.Contains(err.Error(), "SETTINGS_LOCALE_CONTRACT_INVALID") {
		t.Fatalf("v2 guard should still reject unsupported locales, got %v", err)
	}
	var stored struct {
		Settings string `db:"settings"`
	}
	if err := app.DB().NewQuery("SELECT settings FROM settings WHERE id = 'existing_en'").One(&stored); err != nil {
		t.Fatal(err)
	}
	if want := `{"localePreference":"en-US","monthlyBudget":"42"}`; stored.Settings != want {
		t.Fatalf("guard v2 changed settings data: got %s want %s", stored.Settings, want)
	}

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatalf("second startup after guard v2 failed: %v", err)
	}
	if _, err := app.DB().NewQuery("DROP TRIGGER " + settingsLocalePreferenceInsertGuardName).Execute(); err != nil {
		t.Fatal(err)
	}
	if err := runSchemaDataMigrations(app); err == nil || !strings.Contains(err.Error(), "guard drift") {
		t.Fatal(fmt.Errorf("guard v2 drift validation error = %v", err))
	}
}
