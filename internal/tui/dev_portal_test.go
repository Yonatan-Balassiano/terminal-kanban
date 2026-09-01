package tui

import "testing"

func TestGetTaskDevPortalURL(t *testing.T) {
	cases := []struct {
		name    string
		release *TaskReleaseSummary
		want    string
	}{
		{
			name:    "no release status yet",
			release: nil,
			want:    "",
		},
		{
			name:    "still awaiting a build",
			release: &TaskReleaseSummary{Stage: "awaiting-build", BlockingArtifactName: "com.wixpress.web5.svc"},
			want:    "",
		},
		{
			name:    "build succeeded, not yet rolled out",
			release: &TaskReleaseSummary{Stage: "rc-built", BlockingArtifactName: "com.wixpress.bo-web5-history"},
			want:    "https://wix-bo.com/dev/project/com.wixpress.bo-web5-history",
		},
		{
			name:    "rolling out to production",
			release: &TaskReleaseSummary{Stage: "rolling-out", BlockingArtifactName: "com.wixpress.bo-web5-history"},
			want:    "https://wix-bo.com/dev/project/com.wixpress.bo-web5-history",
		},
		{
			name:    "fully shipped — nothing left blocking, so no artifact name to build the link from",
			release: &TaskReleaseSummary{Stage: "ga", BlockingArtifactName: ""},
			want:    "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			task := &TaskRecord{Release: tc.release}
			if got := getTaskDevPortalURL(task); got != tc.want {
				t.Fatalf("getTaskDevPortalURL() = %q, want %q", got, tc.want)
			}
		})
	}
}
