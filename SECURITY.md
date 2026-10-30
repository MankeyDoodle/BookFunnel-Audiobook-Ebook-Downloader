# Security

This script runs in your logged-in BookFunnel session and sends network
requests only to BookFunnel's own hosts and its storage hosts (see the
`@connect` lines in the header). It does not send your data anywhere else.

If you find a way it could leak data, expose a signed link, or write files
somewhere unexpected, please open a private security advisory on GitHub
("Security" tab, "Report a vulnerability") instead of a public issue.
