package tui

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type rpcRequest struct {
	ID     string      `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params,omitempty"`
}

type rpcResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

type RPCEvent struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// How long to keep trying to find the daemon again after it goes away, and how
// often. Restarting the daemon is a normal part of working on it, so the board
// is expected to survive one rather than have to be restarted alongside it.
const (
	reconnectInterval = 250 * time.Millisecond
	reconnectWindow   = 30 * time.Second
)

// errDaemonRestarted replaces the raw "broken pipe" a severed socket produces,
// which says nothing a user can act on.
var errDaemonRestarted = errors.New("lost the daemon connection; reconnecting")

type RPCClient struct {
	socketPath string
	events     chan RPCEvent
	closed     chan struct{}
	counter    atomic.Uint64

	connMu sync.Mutex
	conn   net.Conn

	writeMu   sync.Mutex
	pendingMu sync.Mutex
	pending   map[string]chan rpcResponse

	// Replayed after a reconnect, so board pushes resume without the model
	// having to notice the connection ever dropped.
	subscribed atomic.Bool
}

func NewRPCClient(socketPath string) (*RPCClient, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, err
	}

	client := &RPCClient{
		socketPath: socketPath,
		conn:       conn,
		events:     make(chan RPCEvent, 512),
		closed:     make(chan struct{}),
		pending:    make(map[string]chan rpcResponse),
	}
	go client.readLoop()
	return client, nil
}

func (c *RPCClient) currentConn() net.Conn {
	c.connMu.Lock()
	defer c.connMu.Unlock()
	return c.conn
}

func (c *RPCClient) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// redial waits for the daemon to come back and takes over the connection.
//
// Reports false only when the client is shutting down or the daemon never
// returns, which is the one case where the board genuinely cannot continue.
func (c *RPCClient) redial() bool {
	deadline := time.Now().Add(reconnectWindow)

	for time.Now().Before(deadline) {
		if c.isClosed() {
			return false
		}

		conn, err := net.Dial("unix", c.socketPath)
		if err != nil {
			time.Sleep(reconnectInterval)
			continue
		}

		c.connMu.Lock()
		previous := c.conn
		c.conn = conn
		c.connMu.Unlock()
		if previous != nil {
			_ = previous.Close()
		}

		// The new connection knows nothing of the old subscription, so board
		// pushes would silently stop arriving without this.
		if c.subscribed.Load() {
			go func() {
				_ = c.Call("subscribe", nil, nil)
			}()
		}
		return true
	}

	return false
}

func (c *RPCClient) Events() <-chan RPCEvent {
	return c.events
}

func (c *RPCClient) Subscribe() error {
	if err := c.Call("subscribe", nil, nil); err != nil {
		return err
	}
	c.subscribed.Store(true)
	return nil
}

func (c *RPCClient) Close() error {
	select {
	case <-c.closed:
		return nil
	default:
		close(c.closed)
	}
	return c.currentConn().Close()
}

func (c *RPCClient) readLoop() {
	for {
		if c.readFrom(c.currentConn()) {
			return
		}

		// The connection dropped. Anything still waiting on it will never be
		// answered, so fail it now rather than let it sit until its timeout.
		c.failPending(errDaemonRestarted)
		if c.isClosed() || !c.redial() {
			close(c.events)
			return
		}
	}
}

// readFrom pumps one connection until it ends. Reports whether the client is
// shutting down, as opposed to the connection merely having dropped.
func (c *RPCClient) readFrom(conn net.Conn) bool {
	reader := bufio.NewReader(conn)

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return c.isClosed()
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var probe map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &probe); err != nil {
			continue
		}

		if _, ok := probe["type"]; ok {
			var event RPCEvent
			if err := json.Unmarshal([]byte(line), &event); err == nil {
				select {
				case c.events <- event:
				default:
				}
			}
			continue
		}

		var response rpcResponse
		if err := json.Unmarshal([]byte(line), &response); err != nil {
			continue
		}

		c.pendingMu.Lock()
		waiter := c.pending[response.ID]
		if waiter != nil {
			delete(c.pending, response.ID)
		}
		c.pendingMu.Unlock()

		if waiter != nil {
			waiter <- response
		}
	}
}

func (c *RPCClient) failPending(err error) {
	response := rpcResponse{
		Error: &rpcError{Message: err.Error()},
	}

	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()

	for id, waiter := range c.pending {
		response.ID = id
		select {
		case waiter <- response:
		default:
		}
		delete(c.pending, id)
	}
}

func (c *RPCClient) nextID() string {
	return fmt.Sprintf("go-%d", c.counter.Add(1))
}

func rpcTimeout(method string) time.Duration {
	switch method {
	case "chatTurn":
		// A single chat turn may span multiple Ollama/tool-call rounds.
		return 8 * time.Minute
	case "shutdownManagedOllama":
		return 20 * time.Second
	case "createTaskPR", "commentTaskPR", "mergeTaskPR", "triggerSync",
		// The branch-scoped forms do the same gh round trip as the card-scoped
		// ones; on the default timeout a real merge reads to the user as a
		// failure while the daemon goes on to complete it.
		"mergeTaskBranchPR", "commentTaskBranchPR", "addTaskBranch", "removeTaskBranch":
		return 45 * time.Second
	case "refreshArtifacts":
		// Bypasses the daemon cache and re-reads the upstream artifact catalog.
		return 30 * time.Second
	case "rolloutArtifact":
		// A production rollout is registered upstream before it acknowledges.
		return 90 * time.Second
	case "openSession", "recreateSession":
		return 20 * time.Second
	case "reconnectSession":
		// Cold SSH connect to a just-woken host, then a wrapper rebuild. The
		// workspace-start path answers immediately and finishes in the background.
		return 45 * time.Second
	default:
		return 10 * time.Second
	}
}

func (c *RPCClient) Call(method string, params interface{}, target interface{}) error {
	id := c.nextID()
	waiter := make(chan rpcResponse, 1)

	c.pendingMu.Lock()
	c.pending[id] = waiter
	c.pendingMu.Unlock()

	request := rpcRequest{ID: id, Method: method, Params: params}
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}

	if err := c.write(payload); err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return err
	}

	select {
	case response := <-waiter:
		if response.Error != nil {
			return errors.New(response.Error.Message)
		}
		if target == nil || len(response.Result) == 0 || string(response.Result) == "null" {
			return nil
		}
		return json.Unmarshal(response.Result, target)
	case <-time.After(rpcTimeout(method)):
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return fmt.Errorf("rpc call timed out: %s", method)
	}
}

func (c *RPCClient) Notify(method string, params interface{}) error {
	request := rpcRequest{ID: "", Method: method, Params: params}
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}

	return c.write(payload)
}

// write sends one framed message, retrying once on a connection that has died.
//
// A daemon restart severs the socket without warning, and the first write after
// it fails with a raw "broken pipe" that tells the user nothing. The read loop
// is already redialling by then, so waiting briefly and trying the new
// connection turns the common case into no error at all.
func (c *RPCClient) write(payload []byte) error {
	framed := append(payload, '\n')

	c.writeMu.Lock()
	_, err := c.currentConn().Write(framed)
	c.writeMu.Unlock()
	if err == nil {
		return nil
	}

	broken := c.currentConn()
	deadline := time.Now().Add(reconnectWindow)
	for time.Now().Before(deadline) {
		if c.isClosed() {
			return errDaemonRestarted
		}
		if c.currentConn() != broken {
			break
		}
		time.Sleep(reconnectInterval)
	}

	if c.currentConn() == broken {
		return errDaemonRestarted
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.currentConn().Write(framed)
	if err != nil {
		return errDaemonRestarted
	}
	return nil
}
