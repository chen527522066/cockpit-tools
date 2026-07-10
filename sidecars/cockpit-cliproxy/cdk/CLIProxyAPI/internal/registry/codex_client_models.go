package registry

import (
	_ "embed"
	"encoding/json"
	"strings"
	"sync"
)

//go:embed models/codex_client_models.json
var codexClientModelsJSON []byte

type codexClientModelOverridesPayload struct {
	ModelOverrides []codexClientModelOverride `json:"model_overrides"`
}

type codexClientModelOverride struct {
	Slug                     string                      `json:"slug"`
	DisplayName              string                      `json:"display_name"`
	Description              string                      `json:"description"`
	ContextWindow            int                         `json:"context_window"`
	SupportedReasoningLevels []codexClientReasoningLevel `json:"supported_reasoning_levels"`
}

type codexClientReasoningLevel struct {
	Effort string `json:"effort"`
}

var (
	codexClientBuiltinModelsOnce sync.Once
	codexClientBuiltinModels     []*ModelInfo
)

// GetCodexClientModelsJSON returns the embedded Codex client model catalog.
func GetCodexClientModelsJSON() []byte {
	return append([]byte(nil), codexClientModelsJSON...)
}

func codexClientBuiltinModelInfos() []*ModelInfo {
	codexClientBuiltinModelsOnce.Do(func() {
		var payload codexClientModelOverridesPayload
		if err := json.Unmarshal(codexClientModelsJSON, &payload); err != nil {
			return
		}
		for _, model := range payload.ModelOverrides {
			slug := strings.TrimSpace(model.Slug)
			if slug == "" {
				continue
			}
			levels := make([]string, 0, len(model.SupportedReasoningLevels))
			for _, rawLevel := range model.SupportedReasoningLevels {
				level := strings.ToLower(strings.TrimSpace(rawLevel.Effort))
				if level != "" {
					levels = append(levels, level)
				}
			}
			codexClientBuiltinModels = append(codexClientBuiltinModels, &ModelInfo{
				ID:            slug,
				Object:        "model",
				OwnedBy:       "openai",
				Type:          "openai",
				DisplayName:   model.DisplayName,
				Version:       slug,
				Description:   model.Description,
				ContextLength: model.ContextWindow,
				Thinking:      &ThinkingSupport{Levels: levels},
			})
		}
	})

	return cloneModelInfos(codexClientBuiltinModels)
}
