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
	if badge.Label != releaseMergedGlyph+" merged" {
		t.Fatalf("label = %q, want a plain merged label", badge.Label)
	}
	// Not purple: purple is reserved for work that is actually live, and an
	// unresolved card has not been shown to be.
	if badge.Tone == "purple" {
		t.Fatalf("tone = %q, want anything but purple", badge.Tone)
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
			want:    releaseShippedGlyph + " GA 1.279.0",
		},
		{
			name:    "rolling out names the version on its way",
			release: &TaskReleaseSummary{Stage: "rolling-out", BlockingRcVersion: "1.292.0"},
			want:    releaseRollingGlyph + " rollout 1.292.0",
		},
		{
			name:    "built but not shipped names the candidate",
			release: &TaskReleaseSummary{Stage: "rc-built", BlockingRcVersion: "1.292.0"},
			want:    releasePendingGlyph + " rc 1.292.0",
		},
		{
			name:    "waiting on a build says so",
			release: &TaskReleaseSummary{Stage: "awaiting-build"},
			want:    releasePendingGlyph + " building",
		},
		{
			name:    "nothing to ship stays plain",
			release: &TaskReleaseSummary{Stage: "no-artifact"},
			want:    releaseMergedGlyph + " merged",
		},
		{
			name:    "unknown says so, rather than implying a verdict",
			release: &TaskReleaseSummary{Stage: "unknown", Confidence: "unknown"},
			want:    releaseMergedGlyph + " merged ?",
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

	// no-artifact matters most here: "nothing tracked ships this" is a different
	// fact from "this is running in production", and they used to look identical.
	for _, stage := range []string{"rc-built", "awaiting-build", "rolling-out", "no-artifact", "unknown"} {
		tone := githubStatusTone(mergedTask(&TaskReleaseSummary{Stage: stage}))
		if tone == "purple" {
			t.Fatalf("stage %q rendered as purple; it has not shipped", stage)
		}
	}
}
