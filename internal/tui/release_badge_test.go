package tui

import "testing"

func mergedTask(release *TaskReleaseSummary) TaskRecord {
	return TaskRecord{PRState: "merged", Release: release}
}

// A merged card that the daemon has not resolved must read exactly as it did
// before release tracking existed. Anything else would tell the user something
// about production that nobody actually checked.
func TestMergedCardWithoutReleaseStatusReadsAsBefore(t *testing.T) {
	badge := githubStatusBadgeModel(mergedTask(nil))

	if badge == nil {
		t.Fatal("expected a badge for a merged task")
	}
	if badge.Label != "merged" {
		t.Fatalf("label = %q, want %q", badge.Label, "merged")
	}
	if badge.Tone != "purple" {
		t.Fatalf("tone = %q, want purple", badge.Tone)
	}
}

func TestReleaseStageLabelNamesTheVersionThatMatters(t *testing.T) {
	cases := []struct {
		name    string
		release *TaskReleaseSummary
		want    string
	}{
		{
			name:    "shipped names the production version",
			release: &TaskReleaseSummary{Stage: "ga", BlockingGaVersion: "1.279.0"},
			want:    "GA 1.279.0",
		},
		{
			name:    "rolling out names the version on its way",
			release: &TaskReleaseSummary{Stage: "rolling-out", BlockingRcVersion: "1.292.0"},
			want:    "rollout 1.292.0",
		},
		{
			name:    "built but not shipped names the candidate",
			release: &TaskReleaseSummary{Stage: "rc-built", BlockingRcVersion: "1.292.0"},
			want:    "rc 1.292.0",
		},
		{
			name:    "waiting on a build says so",
			release: &TaskReleaseSummary{Stage: "awaiting-build"},
			want:    "merged·building",
		},
		{
			name:    "nothing to ship stays plain",
			release: &TaskReleaseSummary{Stage: "no-artifact"},
			want:    "merged",
		},
		{
			name:    "unknown never implies a verdict",
			release: &TaskReleaseSummary{Stage: "unknown", Confidence: "unknown"},
			want:    "merged",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := releaseStageLabel(tc.release); got != tc.want {
				t.Fatalf("label = %q, want %q", got, tc.want)
			}
		})
	}
}

// Purple has always meant "done with". It must now mean shipped, so a card
// still waiting on a rollout cannot look finished at a glance.
func TestOnlyShippedWorkKeepsThePurpleBadge(t *testing.T) {
	shipped := githubStatusTone(mergedTask(&TaskReleaseSummary{Stage: "ga"}))
	if shipped != "purple" {
		t.Fatalf("shipped tone = %q, want purple", shipped)
	}

	for _, stage := range []string{"rc-built", "awaiting-build", "rolling-out"} {
		tone := githubStatusTone(mergedTask(&TaskReleaseSummary{Stage: stage}))
		if tone == "purple" {
			t.Fatalf("stage %q rendered as purple; it has not shipped", stage)
		}
	}
}
