package openai

import "testing"

func TestBuildCodexClientModelsPreserves56Capabilities(t *testing.T) {
	models := buildCodexClientModels([]map[string]any{
		{"id": "gpt-5.4-mini"},
		{"id": "gpt-5.5"},
		{"id": "gpt-5.6-terra"},
		{"id": "gpt-5.4"},
		{"id": "gpt-5.6-luna"},
		{"id": "gpt-5.6-sol"},
	})
	wantOrder := []string{
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.5",
		"gpt-5.4",
		"gpt-5.4-mini",
	}
	for index, want := range wantOrder {
		if got := stringModelValue(models[index], "slug"); got != want {
			t.Fatalf("model[%d] = %q, want %q", index, got, want)
		}
	}

	bySlug := make(map[string]map[string]any, len(models))
	for _, model := range models {
		bySlug[stringModelValue(model, "slug")] = model
	}

	for _, testCase := range []struct {
		slug          string
		defaultEffort string
		supportsUltra bool
	}{
		{slug: "gpt-5.6-sol", defaultEffort: "low", supportsUltra: true},
		{slug: "gpt-5.6-terra", defaultEffort: "medium", supportsUltra: true},
		{slug: "gpt-5.6-luna", defaultEffort: "medium", supportsUltra: false},
	} {
		model := bySlug[testCase.slug]
		if model == nil {
			t.Fatalf("expected model %s", testCase.slug)
		}
		if got := stringModelValue(model, "default_reasoning_level"); got != testCase.defaultEffort {
			t.Fatalf("%s default reasoning = %q, want %q", testCase.slug, got, testCase.defaultEffort)
		}
		levels, ok := model["supported_reasoning_levels"].([]any)
		if !ok {
			t.Fatalf("%s reasoning levels = %#v", testCase.slug, model["supported_reasoning_levels"])
		}
		hasMax := false
		hasUltra := false
		for _, rawLevel := range levels {
			level, _ := rawLevel.(map[string]any)
			switch stringModelValue(level, "effort") {
			case "max":
				hasMax = true
			case "ultra":
				hasUltra = true
			}
		}
		if !hasMax || hasUltra != testCase.supportsUltra {
			t.Fatalf("%s reasoning levels max=%v ultra=%v", testCase.slug, hasMax, hasUltra)
		}
		speedTiers, ok := model["additional_speed_tiers"].([]any)
		if !ok || len(speedTiers) != 1 || speedTiers[0] != "fast" {
			t.Fatalf("%s speed tiers = %#v", testCase.slug, model["additional_speed_tiers"])
		}
		serviceTiers, ok := model["service_tiers"].([]any)
		if !ok || len(serviceTiers) != 1 {
			t.Fatalf("%s service tiers = %#v", testCase.slug, model["service_tiers"])
		}
	}
}
