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

type RPCClient struct {
	conn    net.Conn
	events  chan RPCEvent
	closed  chan struct{}
	counter atomic.Uint64

	writeMu   sync.Mutex
	pendingMu sync.Mutex
	pending   map[string]chan rpcResponse
}

func NewRPCClient(socketPath string) (*RPCClient, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, err
	}

	client := &RPCClient{
		conn:    conn,
		events:  make(chan RPCEvent, 512),
		closed:  make(chan struct{}),
		pending: make(map[string]chan rpcResponse),
	}
	go client.readLoop()
	return client, nil
}

func (c *RPCClient) Events() <-chan RPCEvent {
	return c.events
}

func (c *RPCClient) Subscribe() error {
	return c.Call("subscribe", nil, nil)
}

func (c *RPCClient) Close() error {
	select {
	case <-c.closed:
		return nil
	default:
		close(c.closed)
	}
	return c.conn.Close()
}

func (c *RPCClient) readLoop() {
	reader := bufio.NewReader(c.conn)

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			c.failPending(err)
			close(c.events)
			return
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

	c.writeMu.Lock()
	_, err = c.conn.Write(append(payload, '\n'))
	c.writeMu.Unlock()
	if err != nil {
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

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.conn.Write(append(payload, '\n'))
	return err
}
