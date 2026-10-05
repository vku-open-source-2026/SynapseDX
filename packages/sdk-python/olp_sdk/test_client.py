def test_import():
    from olp_sdk import OlpClient
    c = OlpClient("http://localhost:8080")
    assert c.base_url == "http://localhost:8080"
