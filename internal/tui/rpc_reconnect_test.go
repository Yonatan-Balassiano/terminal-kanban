package tui

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// socketPath returns a short path for the unix socket.
//
// t.TempDir() sits under /var/folders/... on macOS, which overruns the ~104
// character limit the kernel puts on a socket address and fails with a bare
// "invalid argument".
func socketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "abrpc")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "d.sock")
}

// fakeDaemon is a socket that answers RPC calls, and can be killed and brought
// back at the same path — which is exactly what `npm run reset-daemon` does
// underneath a running board.
type fakeDaemon struct {
	path string

	mu       sync.Mutex
	listener net.Listener
	conns    []net.Conn
	calls    []string
}

func startFakeDaemon(t *testing.T, path string) *fakeDaemon {
	t.Helper()
	d := &fakeDaemon{path: path}
	d.listen(t)
	return d
}

func (d *fakeDaemon) listen(t *testing.T) {
	t.Helper()
	listener, err := net.Listen("unix", d.path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	d.mu.Lock()
	d.listener = listener
	d.mu.Unlock()

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			d.mu.Lock()
			d.conns = append(d.conns, conn)
			d.mu.Unlock()
			go d.serve(conn)
		}
	}()
}

func (d *fakeDaemon) serve(conn net.Conn) {
	reader := bufio.NewReader(conn)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}

		var request struct {
			ID     string `json:"id"`
			Method string `json:"method"`
		}
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			continue
		}

		d.mu.Lock()
		d.calls = append(d.calls, request.Method)
		d.mu.Unlock()

		// Deliberately never answered, so a caller can be left genuinely in
		// flight while the daemon is taken away underneath it.
		if request.ID == "" || request.Method == "neverAnswered" {
			continue
		}
		payload, _ := json.Marshal(map[string]any{
			"id":     request.ID,
			"result": map[string]string{"ok": request.Method},
		})
		if _, err := conn.Write(append(payload, '\n')); err != nil {
			return
		}
	}
}

// restart drops every connection and rebinds the socket, the way a daemon
// restart looks from the board's side.
func (d *fakeDaemon) restart(t *testing.T) {
	t.Helper()
	d.mu.Lock()
	listener := d.listener
	conns := d.conns
	d.conns = nil
	d.mu.Unlock()

	_ = listener.Close()
	for _, conn := range conns {
		_ = conn.Close()
	}

	d.listen(t)
}

func (d *fakeDaemon) methodCalls(method string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	count := 0
	for _, call := range d.calls {
		if call == method {
			count++
		}
	}
	return count
}

func (d *fakeDaemon) stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.listener != nil {
		_ = d.listener.Close()
	}
	for _, conn := range d.conns {
		_ = conn.Close()
	}
}

// Restarting the daemon is a normal part of working on it, and it used to leave
// the board permanently dead: the next action failed with a raw
// "write unix …: broken pipe" and never recovered until the whole TUI was
// restarted too.
func TestClientKeepsWorkingAcrossADaemonRestart(t *testing.T) {
	socket := socketPath(t)
	daemon := startFakeDaemon(t, socket)
	defer daemon.stop()

	client, err := NewRPCClient(socket)
	if err != nil {
		t.Fatalf("NewRPCClient: %v", err)
	}
	defer client.Close()

	var before map[string]string
	if err := client.Call("getBoard", nil, &before); err != nil {
		t.Fatalf("call before restart: %v", err)
	}

	daemon.restart(t)

	// The very action a user takes next — creating a card — must succeed.
	var after map[string]string
	if err := client.Call("createTask", map[string]string{"title": "x"}, &after); err != nil {
		t.Fatalf("call after restart: %v", err)
	}
	if after["ok"] != "createTask" {
		t.Fatalf("unexpected result after restart: %v", after)
	}
}

// A dropped connection knows nothing of the old subscription, so board pushes
// would stop arriving with no error anywhere.
func TestSubscriptionIsRestoredAfterAReconnect(t *testing.T) {
	socket := socketPath(t)
	daemon := startFakeDaemon(t, socket)
	defer daemon.stop()

	client, err := NewRPCClient(socket)
	if err != nil {
		t.Fatalf("NewRPCClient: %v", err)
	}
	defer client.Close()

	if err := client.Subscribe(); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	daemon.restart(t)

	// Force the client to notice, then let the replayed subscribe land.
	var result map[string]string
	if err := client.Call("getBoard", nil, &result); err != nil {
		t.Fatalf("call after restart: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if daemon.methodCalls("subscribe") >= 2 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("subscribe was not replayed after the reconnect (saw %d)", daemon.methodCalls("subscribe"))
}

// A call already in flight when the socket dies cannot be answered. It has to
// fail immediately and say something actionable, rather than sit until its
// timeout — up to 45s for a merge.
func TestInFlightCallsFailFastWhenTheDaemonGoesAway(t *testing.T) {
	socket := socketPath(t)
	daemon := startFakeDaemon(t, socket)

	client, err := NewRPCClient(socket)
	if err != nil {
		t.Fatalf("NewRPCClient: %v", err)
	}
	defer client.Close()

	done := make(chan error, 1)
	go func() {
		done <- client.Call("neverAnswered", nil, nil)
	}()

	time.Sleep(50 * time.Millisecond)
	daemon.stop()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected the in-flight call to fail once the daemon went away")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("in-flight call hung instead of failing when the daemon went away")
	}
}
